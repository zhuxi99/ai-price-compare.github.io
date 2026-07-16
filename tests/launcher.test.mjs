import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(import.meta.dirname, '..');
const launcherPath = path.join(projectRoot, 'AI价格比对-一键发布.desktop');
const scriptPath = path.join(projectRoot, 'scripts', '一键发布.sh');

test('the desktop launcher is valid and points to an executable publish script', async () => {
  const launcher = await readFile(launcherPath, 'utf8');

  assert.match(launcher, /^\[Desktop Entry\]$/m);
  assert.match(launcher, new RegExp(`^Exec=${scriptPath}$`, 'm'));
  assert.match(launcher, /^Terminal=true$/m);
  await access(scriptPath, 1);
  await execFile('desktop-file-validate', [launcherPath]);
});

test('the publish script can safely verify the latest backup without deploying', async () => {
  const dataPath = path.join(tmpdir(), `ai-price-launcher-data-${process.pid}.json`);
  await writeFile(dataPath, JSON.stringify({
    version: 2,
    exportedAt: '2026-07-16T00:00:00.000Z',
    entries: [{
      id: 'launcher-entry', modelName: '发布检查模型', category: '测试', provider: '测试站',
      relayAddress: '', useMultiplier: false, multiplier: null,
      baseInputPrice: 1, baseCacheInputPrice: 0.5, baseOutputPrice: 2,
      createdAt: 1, updatedAt: 1
    }]
  }));
  try {
    const result = await execFile(scriptPath, ['--prepare-only', dataPath], {
    cwd: projectRoot,
    maxBuffer: 1_000_000
    });
    const [generatedPage, githubPage] = await Promise.all([
      readFile(path.join(projectRoot, '.surge', 'index.html'), 'utf8'),
      readFile(path.join(projectRoot, 'index.html'), 'utf8')
    ]);

    assert.doesNotMatch(generatedPage, /PUBLISHED_DATA = null/);
    assert.match(githubPage, /src="background\.webp"/);
    assert.match(generatedPage, /src="https:\/\/zhuxi99\.github\.io\/ai-price-compare\.github\.io\/background\.webp"/);
    await assert.rejects(stat(path.join(projectRoot, '.surge', 'background.webp')), /ENOENT/);
    assert.match(result.stdout, /检查成功，未执行线上发布/);
  } finally {
    await rm(dataPath, { force: true });
  }
});

test('a successful one-click publish commits and pushes the GitHub Pages file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-launcher-git-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npmPath = path.join(directory, 'npm');
  const gitPath = path.join(directory, 'git');
  const gitCallLog = path.join(directory, 'git-calls.log');
  await writeFile(gitCallLog, '');
  await writeFile(npmPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(gitPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_CALL_LOG"
if [[ "$*" == "diff --cached --quiet -- index.html" ]]; then
  exit 1
fi
exit 0
`, { mode: 0o755 });

  const result = await execFile(scriptPath, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GIT_CALL_LOG: gitCallLog,
      PUBLISH_LOG_FILE: path.join(directory, 'publish.log')
    },
    maxBuffer: 1_000_000
  });
  const gitCalls = await readFile(gitCallLog, 'utf8');

  assert.match(gitCalls, /^add -- index\.html$/m);
  assert.match(gitCalls, /^diff --cached --quiet -- index\.html$/m);
  assert.match(gitCalls, /^commit -m Update published site -- index\.html$/m);
  assert.match(gitCalls, /^push origin main$/m);
  assert.match(result.stdout, /GitHub Pages 发布成功/);
});

test('the background upload switch includes the optimized image in the publish commit', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-launcher-background-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npmPath = path.join(directory, 'npm');
  const gitPath = path.join(directory, 'git');
  const gitCallLog = path.join(directory, 'git-calls.log');
  await writeFile(gitCallLog, '');
  await writeFile(npmPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(gitPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_CALL_LOG"
if [[ "$*" == "diff --cached --quiet -- index.html background.webp" ]]; then
  exit 1
fi
exit 0
`, { mode: 0o755 });

  await execFile(scriptPath, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GIT_CALL_LOG: gitCallLog,
      UPLOAD_BACKGROUND_ASSET: 'true',
      PUBLISH_LOG_FILE: path.join(directory, 'publish.log')
    },
    maxBuffer: 1_000_000
  });
  const gitCalls = await readFile(gitCallLog, 'utf8');

  assert.match(gitCalls, /^add -- index\.html background\.webp$/m);
  assert.match(gitCalls, /^diff --cached --quiet -- index\.html background\.webp$/m);
  assert.match(gitCalls, /^commit -m Update published site -- index\.html background\.webp$/m);
});

test('one-click publish retries transient GitHub push failures', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-launcher-retry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npmPath = path.join(directory, 'npm');
  const gitPath = path.join(directory, 'git');
  const pushCountPath = path.join(directory, 'push-count');
  await writeFile(npmPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(gitPath, `#!/usr/bin/env bash
if [[ "$*" == "diff --cached --quiet -- index.html" ]]; then
  exit 0
fi
if [[ "$*" == "push origin main" ]]; then
  count=$(cat "$GIT_PUSH_COUNT_FILE" 2>/dev/null || printf '0')
  count=$((count + 1))
  printf '%s' "$count" > "$GIT_PUSH_COUNT_FILE"
  [[ $count -ge 3 ]]
  exit
fi
exit 0
`, { mode: 0o755 });

  const result = await execFile(scriptPath, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GIT_PUSH_COUNT_FILE: pushCountPath,
      GITHUB_PUSH_RETRY_DELAY: '0',
      PUBLISH_LOG_FILE: path.join(directory, 'publish.log')
    },
    maxBuffer: 1_000_000
  });

  assert.equal(await readFile(pushCountPath, 'utf8'), '3');
  assert.match(result.stdout, /第 1 次推送失败/);
  assert.match(result.stdout, /第 2 次推送失败/);
  assert.match(result.stdout, /GitHub Pages 发布成功/);
});

test('one-click publish times out a hung GitHub push before retrying', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-launcher-timeout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npmPath = path.join(directory, 'npm');
  const gitPath = path.join(directory, 'git');
  const pushCountPath = path.join(directory, 'push-count');
  await writeFile(npmPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(gitPath, `#!/usr/bin/env bash
if [[ "$*" == "diff --cached --quiet -- index.html" ]]; then
  exit 0
fi
if [[ "$*" == "push origin main" ]]; then
  count=$(cat "$GIT_PUSH_COUNT_FILE" 2>/dev/null || printf '0')
  count=$((count + 1))
  printf '%s' "$count" > "$GIT_PUSH_COUNT_FILE"
  if [[ $count -eq 1 ]]; then
    sleep 1
  fi
fi
exit 0
`, { mode: 0o755 });

  const result = await execFile(scriptPath, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GIT_PUSH_COUNT_FILE: pushCountPath,
      GITHUB_PUSH_MAX_ATTEMPTS: '2',
      GITHUB_PUSH_RETRY_DELAY: '0',
      GITHUB_PUSH_TIMEOUT: '0.05',
      PUBLISH_LOG_FILE: path.join(directory, 'publish.log')
    },
    maxBuffer: 1_000_000
  });

  assert.equal(await readFile(pushCountPath, 'utf8'), '2');
  assert.match(result.stdout, /第 1 次推送失败/);
  assert.match(result.stdout, /GitHub Pages 发布成功/);
});
