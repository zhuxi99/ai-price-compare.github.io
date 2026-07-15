import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { findLatestSnapshot, prepareDeployment } from '../scripts/deploy-data.mjs';

const execFile = promisify(execFileCallback);

function validSnapshot(overrides = {}) {
  return {
    exportedAt: '2026-07-15T00:00:00.000Z',
    version: 2,
    entries: [{
      id: 'entry-1',
      modelName: '测试模型',
      category: '测试分类',
      provider: '测试站点',
      relayAddress: 'https://relay.example/register',
      useMultiplier: false,
      multiplier: null,
      baseInputPrice: 1,
      baseCacheInputPrice: 0.5,
      baseOutputPrice: 2,
      createdAt: 1,
      updatedAt: 1
    }],
    ...overrides
  };
}

test('prepares a deployable page containing the exported snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-deploy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const templatePath = path.join(directory, 'template.html');
  const dataPath = path.join(directory, 'data.json');
  const outputPath = path.join(directory, 'public', 'index.html');
  await writeFile(templatePath, '<script>const PUBLISHED_DATA = null; // __PUBLISHED_DATA__</script>');
  await writeFile(dataPath, JSON.stringify(validSnapshot()));

  const result = await prepareDeployment({ templatePath, dataPath, outputPath });
  const output = await readFile(outputPath, 'utf8');

  assert.equal(result.entryCount, 1);
  assert.equal(result.exportedAt, '2026-07-15T00:00:00.000Z');
  assert.match(output, /"modelName":"测试模型"/);
  assert.doesNotMatch(output, /PUBLISHED_DATA = null/);
});

test('refuses to prepare a deployment from an empty snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-deploy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const templatePath = path.join(directory, 'template.html');
  const dataPath = path.join(directory, 'empty.json');
  const outputPath = path.join(directory, 'public', 'index.html');
  await writeFile(templatePath, '<script>const PUBLISHED_DATA = null; // __PUBLISHED_DATA__</script>');
  await writeFile(dataPath, JSON.stringify(validSnapshot({ entries: [] })));

  await assert.rejects(
    prepareDeployment({ templatePath, dataPath, outputPath }),
    /不能发布空数据/
  );
});

test('finds the newest valid non-empty backup and skips newer unusable files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-downloads-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const usablePath = path.join(directory, 'ai-price-data-usable.json');
  const emptyPath = path.join(directory, 'ai-price-data-empty.json');
  const brokenPath = path.join(directory, 'ai-price-data-broken.json');
  await writeFile(usablePath, JSON.stringify(validSnapshot()));
  await writeFile(emptyPath, JSON.stringify(validSnapshot({ entries: [] })));
  await writeFile(brokenPath, '{bad json');
  await utimes(usablePath, new Date(1_000), new Date(1_000));
  await utimes(emptyPath, new Date(2_000), new Date(2_000));
  await utimes(brokenPath, new Date(3_000), new Date(3_000));

  assert.equal(await findLatestSnapshot(directory), usablePath);
});

test('a newer deployment replaces the previously published snapshot in the same browser', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-browser-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataPath = path.join(directory, 'data.json');
  const outputPath = path.join(directory, 'index.html');
  const profilePath = path.join(directory, 'chrome-profile');
  const templatePath = path.resolve(import.meta.dirname, '..', 'ai-price-compare.html');
  const firstSnapshot = validSnapshot();
  await writeFile(dataPath, JSON.stringify(firstSnapshot));
  await prepareDeployment({ templatePath, dataPath, outputPath });

  const chromeArgs = [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--user-data-dir=${profilePath}`, '--dump-dom', pathToFileURL(outputPath).href
  ];
  const firstRender = await execFile('google-chrome', chromeArgs, { maxBuffer: 2_000_000 });
  assert.match(firstRender.stdout, /测试模型/);
  assert.match(firstRender.stdout, /class="relay-address" href="https:\/\/relay\.example\/register"/);

  const secondSnapshot = validSnapshot({
    exportedAt: '2026-07-16T00:00:00.000Z',
    entries: [{ ...firstSnapshot.entries[0], modelName: '更新后的模型', updatedAt: 2 }]
  });
  await writeFile(dataPath, JSON.stringify(secondSnapshot));
  await prepareDeployment({ templatePath, dataPath, outputPath });
  const secondRender = await execFile('google-chrome', chromeArgs, { maxBuffer: 2_000_000 });

  assert.match(secondRender.stdout, /更新后的模型/);
  assert.doesNotMatch(secondRender.stdout, />测试模型</);
});
