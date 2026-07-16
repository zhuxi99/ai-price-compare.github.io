import { spawn } from 'node:child_process';
import { constants, access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_MARKER = 'const PUBLISHED_DATA = null; // __PUBLISHED_DATA__';
const BACKGROUND_SOURCE_MARKER = 'src="background.webp"';
const SHARED_BACKGROUND_URL = 'https://zhuxi99.github.io/ai-price-compare.github.io/background.webp';

function isValidRelayAddress(value) {
  if (value === undefined || value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.id !== 'string' || entry.id.trim() === '') return false;
  if (typeof entry.modelName !== 'string' || entry.modelName.trim() === '') return false;
  if (typeof entry.category !== 'string' || entry.category.trim() === '') return false;
  if (typeof entry.provider !== 'string' || entry.provider.trim() === '') return false;
  if (!isValidRelayAddress(entry.relayAddress)) return false;
  if (typeof entry.useMultiplier !== 'boolean') return false;
  if (entry.useMultiplier) {
    if (typeof entry.multiplier !== 'number' || !Number.isFinite(entry.multiplier) || entry.multiplier <= 0) return false;
  } else if (entry.multiplier !== null) {
    return false;
  }
  if (![entry.baseInputPrice, entry.baseCacheInputPrice, entry.baseOutputPrice]
    .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
  if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) return false;
  if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return false;
  return true;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  if (![1, 2].includes(snapshot.version)) return false;
  if (typeof snapshot.exportedAt !== 'string' || Number.isNaN(Date.parse(snapshot.exportedAt))) return false;
  if (!Array.isArray(snapshot.entries) || !snapshot.entries.every(isValidEntry)) return false;
  const ids = snapshot.entries.map(entry => entry.id);
  return new Set(ids).size === ids.length;
}

async function readValidNonEmptySnapshot(filePath) {
  try {
    const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
    return validateSnapshot(snapshot) && snapshot.entries.length > 0 ? snapshot : null;
  } catch {
    return null;
  }
}

export async function findLatestSnapshot(directory) {
  const names = await readdir(directory);
  const candidates = await Promise.all(names
    .filter(name => /^ai-price-data.*\.json$/i.test(name))
    .map(async name => {
      const filePath = path.join(directory, name);
      try {
        const [fileStat, snapshot] = await Promise.all([
          stat(filePath),
          readValidNonEmptySnapshot(filePath)
        ]);
        return fileStat.isFile() && snapshot ? { filePath, mtimeMs: fileStat.mtimeMs } : null;
      } catch {
        return null;
      }
    }));
  const validCandidates = candidates.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (validCandidates.length === 0) throw new Error(`没有找到有效且非空的价格备份：${directory}`);
  return validCandidates[0].filePath;
}

function serializeForInlineScript(snapshot) {
  return JSON.stringify(snapshot)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export async function prepareDeployment({ templatePath, dataPath, outputPath }) {
  const [template, dataText] = await Promise.all([
    readFile(templatePath, 'utf8'),
    readFile(dataPath, 'utf8')
  ]);
  const snapshot = JSON.parse(dataText);
  if (!validateSnapshot(snapshot)) throw new Error(`数据文件格式不符合要求：${dataPath}`);
  if (snapshot.entries.length === 0) throw new Error(`不能发布空数据：${dataPath}`);
  if (!template.includes(DATA_MARKER)) throw new Error(`页面模板缺少发布数据标记：${templatePath}`);

  const output = template.replace(
    DATA_MARKER,
    `const PUBLISHED_DATA = ${serializeForInlineScript(snapshot)}; // __PUBLISHED_DATA__`
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  return {
    dataPath,
    entryCount: snapshot.entries.length,
    exportedAt: snapshot.exportedAt,
    outputPath
  };
}

async function findDefaultSnapshot() {
  const directories = [path.join(homedir(), '下载'), path.join(homedir(), 'Downloads')];
  for (const directory of directories) {
    try {
      return await findLatestSnapshot(directory);
    } catch (error) {
      if (error.code !== 'ENOENT' && !error.message.startsWith('没有找到有效且非空')) throw error;
    }
  }
  throw new Error(`没有在 ${directories.join(' 或 ')} 找到有效且非空的价格备份`);
}

export async function resolveSurgeCommand(projectRoot) {
  const executableName = process.platform === 'win32' ? 'surge.cmd' : 'surge';
  const pathCandidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory, executableName));
  const candidates = [
    process.env.SURGE_BIN,
    path.join(projectRoot, 'node_modules', '.bin', executableName),
    ...pathCandidates,
    path.join(homedir(), '.npm-global', 'bin', executableName),
    path.join(homedir(), '.local', 'bin', executableName)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation location.
    }
  }

  throw new Error(
    '找不到 Surge 命令。请先执行 `npm install`，或设置 SURGE_BIN 为 Surge 的完整路径。'
  );
}

function runSurge(projectDirectory, domain, surgeCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn(surgeCommand, [projectDirectory, domain], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Surge 部署失败，退出码：${code}`));
    });
  });
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const backgroundPath = path.join(projectRoot, 'background.webp');
  const surgeDirectory = path.join(projectRoot, '.surge');
  const surgeBackgroundPath = path.join(surgeDirectory, 'background.webp');
  const args = process.argv.slice(2);
  const prepareOnly = args.includes('--prepare-only');
  const uploadBackground = args.includes('--upload-background');
  const explicitPath = args.find(argument => !argument.startsWith('--'));
  const dataPath = explicitPath ? path.resolve(explicitPath) : await findDefaultSnapshot();
  const githubPagesPath = path.join(projectRoot, 'index.html');
  const result = await prepareDeployment({
    templatePath: path.join(projectRoot, 'ai-price-compare.html'),
    dataPath,
    outputPath: githubPagesPath
  });
  const githubPage = await readFile(githubPagesPath, 'utf8');
  if (!githubPage.includes(BACKGROUND_SOURCE_MARKER)) {
    throw new Error('页面模板缺少背景资源标记');
  }
  const surgePage = uploadBackground
    ? githubPage
    : githubPage.replace(BACKGROUND_SOURCE_MARKER, `src="${SHARED_BACKGROUND_URL}"`);
  await mkdir(surgeDirectory, { recursive: true });
  await writeFile(path.join(surgeDirectory, 'index.html'), surgePage);
  await rm(path.join(surgeDirectory, 'background.webm'), { force: true });
  if (uploadBackground) await copyFile(backgroundPath, surgeBackgroundPath);
  else await rm(surgeBackgroundPath, { force: true });

  console.log(`已生成发布页：${result.entryCount} 条记录`);
  console.log(`数据文件：${result.dataPath}`);
  console.log(`数据时间：${result.exportedAt}`);
  console.log(`GitHub Pages：${githubPagesPath}`);
  console.log(uploadBackground
    ? `背景图片：本次上传 ${backgroundPath}`
    : `背景图片：复用线上文件 ${SHARED_BACKGROUND_URL}`);
  if (prepareOnly) return;

  const surgeCommand = await resolveSurgeCommand(projectRoot);
  console.log(`使用 Surge：${surgeCommand}`);
  await runSurge(surgeDirectory, 'ai-price-compare.surge.sh', surgeCommand);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`部署失败：${error.message}`);
    process.exitCode = 1;
  });
}
