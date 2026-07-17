import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAccessHeaders,
  calculateModelPrices,
  classifyModel,
  fetchRatioCatalog,
  mergeCatalogIntoSnapshot,
  normalizeSiteUrl
} from '../scripts/ratio-fetch-core.mjs';
import { createRatioFetchServer, extractPublishedSiteCandidates } from '../scripts/ratio-fetch-server.mjs';
import { SavedSitesStore } from '../scripts/saved-sites-store.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('normalizes site URLs and builds compatible access-token headers', () => {
  assert.equal(normalizeSiteUrl('example.com/console?tab=price'), 'https://example.com');
  assert.deepEqual(buildAccessHeaders({ accessToken: 'Bearer secret', userId: '9' }), {
    Accept: 'application/json',
    Authorization: 'Bearer secret',
    'New-API-User': '9',
    'Veloera-User': '9',
    'X-Api-User': '9',
    'voapi-user': '9',
    'User-id': '9',
    'Rix-Api-User': '9',
    'neo-api-user': '9'
  });
});

test('fetches and normalizes a New API pricing catalog with access-token auth', async () => {
  let receivedAuthorization = '';
  let receivedUserId = '';
  const fetchImpl = async (url, options) => {
    receivedAuthorization = options.headers.Authorization;
    receivedUserId = options.headers['New-API-User'];
    if (new URL(url).pathname !== '/api/pricing') return jsonResponse({ message: 'not found' }, 404);
    return jsonResponse({
      success: true,
      data: [{
        model_name: 'gpt-5-test', quota_type: 0, model_ratio: 1.25,
        completion_ratio: 4, enable_groups: ['default']
      }],
      group_ratio: { default: 0.8 },
      usable_group: { default: '默认分组' }
    });
  };
  const catalog = await fetchRatioCatalog({
    siteUrl: 'https://relay.example', accessToken: 'top-secret', userId: '7', fetchImpl
  });
  assert.equal(catalog.sourceType, 'new-api');
  assert.equal(catalog.models[0].modelName, 'gpt-5-test');
  assert.equal(catalog.models[0].modelRatio, 1.25);
  assert.equal(catalog.groupRatio.default, 0.8);
  assert.equal(receivedAuthorization, 'Bearer top-secret');
  assert.equal(receivedUserId, '7');
});

test('auto detection falls back to One Hub endpoints', async () => {
  const fetchImpl = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/pricing') return jsonResponse({ message: 'not found' }, 404);
    if (pathname === '/api/available_model') {
      return jsonResponse({ data: {
        'claude-test': { groups: ['vip'], owned_by: 'anthropic', price: { type: 'tokens', input: 1, output: 5 } }
      }, success: true });
    }
    if (pathname === '/api/user_group_map') {
      return jsonResponse({ data: { vip: { name: 'VIP', ratio: 0.75 } }, success: true });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  const catalog = await fetchRatioCatalog({ siteUrl: 'https://relay.example', siteType: 'auto', fetchImpl });
  assert.equal(catalog.sourceType, 'one-hub');
  assert.equal(catalog.models[0].completionRatio, 5);
  assert.equal(catalog.groupRatio.vip, 0.75);
});

test('classifies models and calculates New API ratio prices', () => {
  assert.equal(classifyModel('claude-fable-5'), 'Claude');
  assert.equal(classifyModel('qwen3-max'), '通义千问 Qwen');
  assert.equal(classifyModel('unknown-model'), '其他模型');
  const prices = calculateModelPrices({
    billingType: 'tokens', modelRatio: 1.5, completionRatio: 4,
    cacheRatio: null, directInputUsd: null, directOutputUsd: null, directCacheUsd: null
  }, 7.2, 0.8);
  assert.equal(prices.baseInputPrice, 21.6);
  assert.equal(prices.actualInputPrice, 17.28);
  assert.equal(prices.actualOutputPrice, 69.12);
});

test('merges selected models without persisting access tokens', () => {
  const snapshot = {
    exportedAt: '2026-07-17T00:00:00.000Z',
    version: 2,
    entries: [{
      id: 'old', modelName: 'gpt-5-test', category: '旧分类', provider: '旧名称',
      relayAddress: 'https://relay.example/register', useMultiplier: false, multiplier: null,
      baseInputPrice: 1, baseCacheInputPrice: 1, baseOutputPrice: 1, createdAt: 1, updatedAt: 1
    }]
  };
  const catalog = {
    baseUrl: 'https://relay.example',
    sourceType: 'new-api',
    groupRatio: { default: 0.8 },
    usableGroup: { default: '默认' },
    models: [{
      modelName: 'gpt-5-test', billingType: 'tokens', modelRatio: 1.25,
      completionRatio: 4, cacheRatio: null, directInputUsd: null,
      directOutputUsd: null, directCacheUsd: null, enableGroups: ['default']
    }]
  };
  const result = mergeCatalogIntoSnapshot({
    snapshot, catalog, selectedModels: ['gpt-5-test'], group: 'default',
    exchangeRate: 7.2, provider: '测试站', categoryMode: 'auto'
  });
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.snapshot.entries[0].category, 'GPT / OpenAI');
  assert.equal(result.snapshot.entries[0].multiplier, 0.8);
  assert.equal(result.snapshot.entries[0].baseInputPrice, 18);
  assert.doesNotMatch(JSON.stringify(result.snapshot), /token|secret|authorization/i);
});

test('local ratio server keeps the token out of its response and rejects foreign origins', async t => {
  let upstreamAuthorization = '';
  const app = createRatioFetchServer({
    fetchImpl: async (url, options) => {
      upstreamAuthorization = options.headers.Authorization;
      assert.equal(new URL(url).pathname, '/api/pricing');
      return jsonResponse({
        success: true,
        data: [{ model_name: 'gpt-local', quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: [] }],
        group_ratio: { default: 1 },
        usable_group: { default: '默认' }
      });
    }
  });
  const origin = await app.listen();
  t.after(() => app.close());

  const requestBody = JSON.stringify({ siteUrl: 'https://relay.example', accessToken: 'server-secret' });
  const response = await fetch(`${origin}/api/fetch-ratios`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: requestBody
  });
  const responseText = await response.text();
  assert.equal(response.status, 200);
  assert.equal(upstreamAuthorization, 'Bearer server-secret');
  assert.doesNotMatch(responseText, /server-secret/);

  const rejected = await fetch(`${origin}/api/fetch-ratios`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: requestBody
  });
  assert.equal(rejected.status, 403);
});

test('saved site tokens are encrypted at rest and blank edits preserve them', async t => {
  const configDirectory = await mkdtemp(path.join(tmpdir(), 'ai-price-saved-sites-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  const store = new SavedSitesStore({ configDirectory });
  const saved = await store.saveSite({
    name: '测试站', siteUrl: 'https://saved.example/register', accessToken: 'persisted-secret',
    userId: '8', siteType: 'new-api', tokenMode: 'bearer'
  });

  const [storeText, storeMode, keyMode] = await Promise.all([
    readFile(store.storePath, 'utf8'),
    stat(store.storePath),
    stat(store.keyPath)
  ]);
  assert.doesNotMatch(storeText, /persisted-secret/);
  assert.equal(storeMode.mode & 0o777, 0o600);
  assert.equal(keyMode.mode & 0o777, 0o600);
  assert.equal((await store.listSites())[0].hasAccessToken, true);
  assert.equal((await store.getSiteWithToken(saved.id)).accessToken, 'persisted-secret');

  await store.saveSite({
    id: saved.id, name: '测试站新名称', siteUrl: 'https://saved.example', accessToken: '',
    userId: '8', siteType: 'new-api', tokenMode: 'bearer'
  });
  assert.equal((await store.getSiteWithToken(saved.id)).accessToken, 'persisted-secret');

  await store.saveSite({
    id: saved.id, name: '测试站新名称', siteUrl: 'https://saved.example', clearAccessToken: true,
    userId: '8', siteType: 'new-api', tokenMode: 'bearer'
  });
  assert.equal((await store.getSiteWithToken(saved.id)).accessToken, '');
});

test('extracts and deduplicates saved sites from existing price data', () => {
  const candidates = extractPublishedSiteCandidates({ entries: [
    { provider: 'Niko', relayAddress: 'https://niko.example/register', updatedAt: 1 },
    { provider: 'NikoAPI', relayAddress: 'https://niko.example/dashboard', updatedAt: 2 },
    { provider: 'NikoAPI', relayAddress: 'https://niko.example/sign-up', updatedAt: 3 },
    { provider: '另一个站', relayAddress: 'relay.example/path', updatedAt: 4 },
    { provider: '', relayAddress: 'https://ignored.example' },
    { provider: '坏地址', relayAddress: 'not a valid host %' }
  ] });
  assert.deepEqual(candidates, [
    { name: '另一个站', siteUrl: 'https://relay.example', entryCount: 1 },
    { name: 'NikoAPI', siteUrl: 'https://niko.example', entryCount: 3 }
  ]);
});

test('imports sites from existing data once and selects saved matches on later imports', async t => {
  const configDirectory = await mkdtemp(path.join(tmpdir(), 'ai-price-import-sites-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  const sitesStore = new SavedSitesStore({ configDirectory });
  const app = createRatioFetchServer({
    sitesStore,
    snapshotResolver: async () => ({
      filePath: '/tmp/existing-price-data.json',
      snapshot: { entries: [
        { provider: '甲站', relayAddress: 'https://one.example/register' },
        { provider: '甲站旧名', relayAddress: 'https://one.example/dashboard' },
        { provider: '乙站', relayAddress: 'https://two.example' }
      ] }
    })
  });
  const origin = await app.listen();
  t.after(() => app.close());

  const importSites = async () => {
    const response = await fetch(`${origin}/api/import-sites`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const first = await importSites();
  assert.equal(first.recognized, 2);
  assert.equal(first.imported, 2);
  assert.equal(first.sites.length, 2);
  assert.equal(first.addedSites.length, 2);
  assert.equal((await sitesStore.listSites()).length, 2);

  const second = await importSites();
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.sites.length, 2);
  assert.equal(second.addedSites.length, 0);
});

test('batch fetching uses each saved site token without returning either secret', async t => {
  const configDirectory = await mkdtemp(path.join(tmpdir(), 'ai-price-batch-sites-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  const sitesStore = new SavedSitesStore({ configDirectory });
  const received = new Map();
  const app = createRatioFetchServer({
    sitesStore,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      received.set(parsed.hostname, options.headers.Authorization);
      return jsonResponse({
        success: true,
        data: [{ model_name: `gpt-${parsed.hostname}`, quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: [] }],
        group_ratio: { default: 1 },
        usable_group: { default: '默认' }
      });
    }
  });
  const origin = await app.listen();
  t.after(() => app.close());

  const saveSite = async site => {
    const response = await fetch(`${origin}/api/save-site`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(site)
    });
    assert.equal(response.status, 200);
    return (await response.json()).site;
  };
  const first = await saveSite({ name: '甲站', siteUrl: 'https://one.example', accessToken: 'secret-one' });
  const second = await saveSite({ name: '乙站', siteUrl: 'https://two.example', accessToken: 'secret-two' });

  const response = await fetch(`${origin}/api/fetch-sites`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteIds: [first.id, second.id] })
  });
  const responseText = await response.text();
  const body = JSON.parse(responseText);
  assert.equal(response.status, 200);
  assert.equal(body.results.filter(result => result.ok).length, 2);
  assert.equal(received.get('one.example'), 'Bearer secret-one');
  assert.equal(received.get('two.example'), 'Bearer secret-two');
  assert.doesNotMatch(responseText, /secret-one|secret-two/);
});
