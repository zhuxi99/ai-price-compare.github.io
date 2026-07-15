import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
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
  const result = await execFile(scriptPath, ['--prepare-only'], {
    cwd: projectRoot,
    maxBuffer: 1_000_000
  });
  const [generatedPage, githubPage] = await Promise.all([
    readFile(path.join(projectRoot, '.surge', 'index.html'), 'utf8'),
    readFile(path.join(projectRoot, 'index.html'), 'utf8')
  ]);

  assert.doesNotMatch(generatedPage, /PUBLISHED_DATA = null/);
  assert.equal(githubPage, generatedPage);
  assert.match(result.stdout, /检查成功，未执行线上发布/);
});
