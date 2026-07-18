import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAccessHeaders,
  calculateModelPrices,
  canonicalTrackedModelName,
  classifyModel,
  fetchRatioCatalog,
  filterTrackedModels,
  mergeCatalogIntoSnapshot,
  normalizeSiteUrl
} from '../scripts/ratio-fetch-core.mjs';
import { createRatioFetchServer, extractPublishedSiteCandidates } from '../scripts/ratio-fetch-server.mjs';
import { SavedSitesStore } from '../scripts/saved-sites-store.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('local fetch UI hides models unavailable in the selected group', async () => {
  const page = await readFile(path.join(PROJECT_ROOT, 'ratio-fetcher.html'), 'utf8');
  assert.match(page, /\.filter\(\(\{ result, model \}\) => isAvailable\(result, model\)\)\s*\.filter\(/);
  assert.doesNotMatch(page, />分组不可用</);
  assert.match(page, /当前分组可用 \$\{availableModels\} 个/);
  assert.match(page, /formatNumber\(change\.after\.input, 8\)/);
  assert.match(page, /formatNumber\(change\.after\.cache, 8\)/);
});

test('canonicalizes only exact tracked model names and rejects explanatory suffixes', () => {
  assert.equal(canonicalTrackedModelName('GPT 5.6 sol'), 'GPT 5.6 sol');
  assert.equal(canonicalTrackedModelName('gpt-5.6-sol'), 'GPT 5.6 sol');
  assert.equal(canonicalTrackedModelName('Claude Fable 5'), 'Claude Fable 5');
  assert.equal(canonicalTrackedModelName('claude-fable-5'), 'Claude Fable 5');
  assert.equal(canonicalTrackedModelName('GPT 5.6 sol plus'), '');
  assert.equal(canonicalTrackedModelName('GPT 5.6 sol 价格稳定'), '');
  assert.equal(canonicalTrackedModelName('Claude Fable 5（非1M）'), '');

  const filtered = filterTrackedModels({ models: [
    { modelName: 'gpt-5.6-sol' },
    { modelName: 'GPT 5.6 sol' },
    { modelName: 'GPT 5.6 sol plus' },
    { modelName: 'claude-fable-5' }
  ] });
  assert.deepEqual(filtered.models.map(model => model.modelName), [
    'Claude Fable 5', 'GPT 5.6 sol'
  ]);
});

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

test('fetches Sub2API runtime models and estimates prices from a saved dashboard JWT', async () => {
  const receivedApiKeys = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'raw.githubusercontent.com') {
      return jsonResponse({
        'gpt-sub2': { input_cost_per_token: 0.000005, output_cost_per_token: 0.00002 },
        'claude-sub2': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 }
      });
    }
    if (parsed.pathname === '/api/v1/groups/available') {
      assert.equal(options.headers.Authorization, 'Bearer dashboard-jwt');
      return jsonResponse({ code: 0, message: 'ok', data: [{ id: 9, name: 'vip', rate_multiplier: 1.5 }] });
    }
    if (parsed.pathname === '/api/v1/groups/rates') {
      return jsonResponse({ code: 0, message: 'ok', data: { 9: 2 } });
    }
    if (parsed.pathname === '/api/v1/keys') {
      return jsonResponse({ code: 0, message: 'ok', data: { items: [
        { id: 1, key: 'sk-runtime-one', status: 'active', group_id: 9 },
        { id: 2, key: 'sk-runtime-two', status: 'active', group: { id: 9, name: 'vip' } }
      ] } });
    }
    if (parsed.pathname === '/v1/models') {
      receivedApiKeys.push(options.headers.Authorization);
      return jsonResponse({ object: 'list', data: [
        { id: 'gpt-sub2' }, { id: 'claude-sub2' }, { id: 'unknown-custom-model' }
      ] });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const catalog = await fetchRatioCatalog({
    siteUrl: 'https://sub2.example', accessToken: 'dashboard-jwt',
    siteType: 'sub2api', fetchImpl
  });
  assert.equal(catalog.sourceType, 'sub2api');
  assert.deepEqual(catalog.groupRatio, { vip: 2 });
  assert.deepEqual(catalog.models.map(model => model.modelName), ['claude-sub2', 'gpt-sub2']);
  assert.equal(catalog.models[1].directInputUsd, 5);
  assert.equal(catalog.models[1].directOutputUsd, 20);
  assert.deepEqual(catalog.models[1].enableGroups, ['vip']);
  assert.deepEqual(receivedApiKeys.sort(), ['Bearer sk-runtime-one', 'Bearer sk-runtime-two']);
});

test('auto detection identifies a Sub2API site and asks for its dashboard JWT', async () => {
  const fetchImpl = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/pricing') return jsonResponse({ message: 'not found' }, 404);
    if (pathname === '/api/v1/auth/me') {
      return jsonResponse({ code: 'UNAUTHORIZED', message: 'Authorization header is required' }, 401);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  await assert.rejects(
    fetchRatioCatalog({ siteUrl: 'https://sub2.example', fetchImpl }),
    /Sub2API.*登录访问令牌/
  );
});

test('reports an expired Sub2API dashboard JWT as a token repair action', async () => {
  const fetchImpl = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/pricing') return jsonResponse({ message: 'not found' }, 404);
    if (pathname === '/api/v1/auth/me') {
      return jsonResponse({ code: 'UNAUTHORIZED', message: 'Authorization header is required' }, 401);
    }
    if (pathname.startsWith('/api/v1/groups/') || pathname === '/api/v1/keys') {
      return jsonResponse({ code: 'UNAUTHORIZED', message: 'token expired' }, 401);
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  await assert.rejects(
    fetchRatioCatalog({
      siteUrl: 'https://sub2-expired.example', accessToken: 'expired-jwt', fetchImpl
    }),
    error => error.code === 'invalid-token' && /失效|过期/.test(error.message)
  );
});

test('a wrong saved token cannot hide an otherwise detectable Sub2API site', async () => {
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'raw.githubusercontent.com') return jsonResponse({ sample_spec: {} });
    if (parsed.pathname === '/api/pricing') return jsonResponse({ message: 'not found' }, 404);
    if (parsed.pathname === '/api/v1/auth/me') {
      if (options.headers?.Authorization) {
        return new Response('<html>not found</html>', {
          status: 404, headers: { 'Content-Type': 'text/html' }
        });
      }
      return jsonResponse({ code: 'UNAUTHORIZED', message: 'Authorization header is required' }, 401);
    }
    if (parsed.pathname.startsWith('/api/v1/groups/') || parsed.pathname === '/api/v1/keys') {
      return jsonResponse({ code: 'UNAUTHORIZED', message: 'invalid token' }, 401);
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  await assert.rejects(
    fetchRatioCatalog({
      siteUrl: 'https://sub2-hidden.example', accessToken: 'sk-wrong-kind-of-token', fetchImpl
    }),
    error => error.code === 'invalid-token' && /Sub2API/.test(error.message)
  );
});

test('reports a site-wide HTTP 403 as server-side protection instead of an unknown backend', async () => {
  const fetchImpl = async () => jsonResponse({ message: 'Forbidden' }, 403);

  await assert.rejects(
    fetchRatioCatalog({ siteUrl: 'https://cloudflare.example', fetchImpl }),
    error => error.code === 'access-blocked' && /Cloudflare|WAF/.test(error.message)
  );
});

test('reports connection timeouts clearly instead of a generic fetch failure', async () => {
  const timeout = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  await assert.rejects(
    fetchRatioCatalog({
      siteUrl: 'https://slow.example',
      siteType: 'new-api',
      fetchImpl: async () => { throw timeout; }
    }),
    /连接目标站点超时/
  );
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
      id: 'old', modelName: 'GPT 5.6 sol', category: '旧分类', provider: '旧名称',
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
      modelName: 'gpt-5.6-sol', billingType: 'tokens', modelRatio: 1.25,
      completionRatio: 4, cacheRatio: null, directInputUsd: null,
      directOutputUsd: null, directCacheUsd: null, enableGroups: ['default']
    }]
  };
  const result = mergeCatalogIntoSnapshot({
    snapshot, catalog, selectedModels: ['GPT 5.6 sol'], group: 'default',
    exchangeRate: 7.2, provider: '测试站', categoryMode: 'auto'
  });
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.snapshot.entries[0].category, '旧分类');
  assert.equal(result.snapshot.entries[0].provider, '旧名称');
  assert.equal(result.snapshot.entries[0].relayAddress, 'https://relay.example/register');
  assert.equal(result.snapshot.entries[0].multiplier, 0.8);
  assert.equal(result.snapshot.entries[0].baseInputPrice, 18);
  assert.doesNotMatch(JSON.stringify(result.snapshot), /token|secret|authorization/i);
});

test('matches canonical model aliases and only updates effective price changes', () => {
  const snapshot = {
    exportedAt: '2026-07-17T00:00:00.000Z', version: 2,
    entries: [{
      id: 'existing', modelName: 'GPT 5.6 sol', category: '人工分类', provider: '原站名',
      relayAddress: 'https://same.example/register?aff=keep', useMultiplier: true,
      multiplier: 0.5, baseInputPrice: 10, baseCacheInputPrice: 10,
      baseOutputPrice: 60, createdAt: 1, updatedAt: 2
    }]
  };
  const catalog = {
    baseUrl: 'https://same.example', groupRatio: { default: 1 }, usableGroup: { default: '默认' },
    models: [{
      modelName: 'gpt-5.6-sol', billingType: 'tokens', modelRatio: 2.5,
      completionRatio: 6, cacheRatio: 1, directInputUsd: null,
      directOutputUsd: null, directCacheUsd: null, enableGroups: []
    }]
  };
  const unchanged = mergeCatalogIntoSnapshot({
    snapshot, catalog, selectedModels: ['gpt-5.6-sol'], group: 'default',
    exchangeRate: 1, provider: '新站名'
  });
  assert.equal(unchanged.added, 0);
  assert.equal(unchanged.updated, 0);
  assert.equal(unchanged.unchanged, 1);
  assert.deepEqual(unchanged.changes, []);
  assert.deepEqual(unchanged.snapshot.entries[0], snapshot.entries[0]);

  catalog.groupRatio.default = 0.8;
  const changed = mergeCatalogIntoSnapshot({
    snapshot, catalog, selectedModels: ['gpt-5.6-sol'], group: 'default',
    exchangeRate: 1, provider: '新站名'
  });
  assert.equal(changed.added, 0);
  assert.equal(changed.updated, 1);
  assert.equal(changed.unchanged, 0);
  assert.equal(changed.changes.length, 1);
  assert.equal(changed.changes[0].type, 'updated');
  assert.equal(changed.changes[0].before.output, 30);
  assert.equal(changed.changes[0].after.output, 24);
  assert.equal(changed.snapshot.entries[0].modelName, 'GPT 5.6 sol');
  assert.equal(changed.snapshot.entries[0].provider, '原站名');
  assert.equal(changed.snapshot.entries[0].relayAddress, 'https://same.example/register?aff=keep');
  assert.equal(changed.snapshot.entries[0].updatedAt > 2, true);
});

test('merge rejects non-target models even when a save request selects them directly', () => {
  const snapshot = { exportedAt: '2026-07-17T00:00:00.000Z', version: 2, entries: [] };
  const result = mergeCatalogIntoSnapshot({
    snapshot,
    catalog: {
      baseUrl: 'https://strict.example', groupRatio: { default: 1 }, usableGroup: { default: '默认' },
      models: [{
        modelName: 'GPT 5.6 sol plus', billingType: 'tokens', modelRatio: 1,
        completionRatio: 2, cacheRatio: 1, directInputUsd: null,
        directOutputUsd: null, directCacheUsd: null, enableGroups: []
      }]
    },
    selectedModels: ['GPT 5.6 sol plus'], group: 'default', exchangeRate: 1,
    provider: '测试站'
  });

  assert.equal(result.selected, 0);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.snapshot.entries, []);
});

test('detects small but real effective price changes', () => {
  const snapshot = {
    exportedAt: '2026-07-17T00:00:00.000Z', version: 2,
    entries: [{
      id: 'small-price', modelName: 'Claude Fable 5', category: 'Claude', provider: '测试站',
      relayAddress: 'https://small.example', useMultiplier: true, multiplier: 1,
      baseInputPrice: 0.00005, baseCacheInputPrice: 0.00005,
      baseOutputPrice: 0.00005, createdAt: 1, updatedAt: 2
    }]
  };
  const result = mergeCatalogIntoSnapshot({
    snapshot,
    catalog: {
      baseUrl: 'https://small.example', groupRatio: { default: 1 }, usableGroup: { default: '默认' },
      models: [{
        modelName: 'claude-fable-5', billingType: 'tokens', modelRatio: 0,
        completionRatio: 1, cacheRatio: 1, directInputUsd: 0.00014,
        directOutputUsd: 0.00014, directCacheUsd: 0.00014, enableGroups: []
      }]
    },
    selectedModels: ['Claude Fable 5'], group: 'default', exchangeRate: 1,
    provider: '测试站'
  });

  assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(result.changes[0].before.input, 0.00005);
  assert.equal(result.changes[0].after.input, 0.00014);
});

test('keeps duplicate price tiers unchanged when any matching tier has the fetched price', () => {
  const snapshot = {
    exportedAt: '2026-07-17T00:00:00.000Z', version: 2,
    entries: [
      {
        id: 'tier-one', modelName: 'GPT 5.6 sol', category: '人工分类', provider: '测试站',
        relayAddress: 'https://tiers.example/register', useMultiplier: true,
        multiplier: 1, baseInputPrice: 4, baseCacheInputPrice: 4,
        baseOutputPrice: 24, createdAt: 1, updatedAt: 2
      },
      {
        id: 'tier-two', modelName: 'gpt-5.6-sol', category: '人工分类', provider: '测试站',
        relayAddress: 'https://tiers.example/register', useMultiplier: true,
        multiplier: 1, baseInputPrice: 5, baseCacheInputPrice: 5,
        baseOutputPrice: 30, createdAt: 3, updatedAt: 4
      }
    ]
  };
  const catalog = {
    baseUrl: 'https://tiers.example', groupRatio: { default: 1 }, usableGroup: { default: '默认' },
    models: [{
      modelName: 'gpt-5.6-sol', billingType: 'tokens', modelRatio: 2.5,
      completionRatio: 6, cacheRatio: 1, directInputUsd: null,
      directOutputUsd: null, directCacheUsd: null, enableGroups: []
    }]
  };

  const result = mergeCatalogIntoSnapshot({
    snapshot, catalog, selectedModels: ['GPT 5.6 sol'], group: 'default',
    exchangeRate: 1, provider: '测试站'
  });

  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.snapshot.entries, snapshot.entries);
  assert.equal(result.snapshot.exportedAt, snapshot.exportedAt);
});

test('applies each site recharge credit ratio to the effective CNY price', () => {
  const snapshot = { exportedAt: '2026-07-17T00:00:00.000Z', version: 2, entries: [] };
  const catalog = {
    baseUrl: 'https://bonus.example', sourceType: 'new-api',
    groupRatio: { default: 0.5 }, usableGroup: { default: '默认' },
    models: [{
      modelName: 'gpt-5.6-sol', billingType: 'tokens', modelRatio: 2.5,
      completionRatio: 4, cacheRatio: null, directInputUsd: null,
      directOutputUsd: null, directCacheUsd: null, enableGroups: ['default']
    }]
  };
  const result = mergeCatalogIntoSnapshot({
    snapshot, catalog, selectedModels: ['GPT 5.6 sol'], group: 'default',
    provider: '充值赠送站', creditPerCny: 10, categoryMode: 'auto'
  });
  const [entry] = result.snapshot.entries;
  assert.equal(entry.baseInputPrice, 0.5);
  assert.equal(entry.baseOutputPrice, 2);
  assert.equal(entry.multiplier, 0.5);
  assert.equal(entry.baseInputPrice * entry.multiplier, 0.25);
});

test('local ratio server keeps the token out of its response and rejects foreign origins', async t => {
  let upstreamAuthorization = '';
  const app = createRatioFetchServer({
    fetchImpl: async (url, options) => {
      upstreamAuthorization = options.headers.Authorization;
      assert.equal(new URL(url).pathname, '/api/pricing');
      return jsonResponse({
        success: true,
        data: [{ model_name: 'gpt-5.6-sol', quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: [] }],
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
    userId: '8', siteType: 'new-api', tokenMode: 'bearer', creditPerCny: 10
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
  assert.equal((await store.listSites())[0].creditPerCny, 10);
  assert.equal((await store.getSiteWithToken(saved.id)).accessToken, 'persisted-secret');

  await store.saveSite({
    id: saved.id, name: '测试站新名称', siteUrl: 'https://saved.example', accessToken: '',
    userId: '8', siteType: 'new-api', tokenMode: 'bearer', creditPerCny: 10
  });
  assert.equal((await store.getSiteWithToken(saved.id)).accessToken, 'persisted-secret');

  await store.saveSite({
    id: saved.id, name: '测试站新名称', siteUrl: 'https://saved.example', clearAccessToken: true,
    userId: '8', siteType: 'new-api', tokenMode: 'bearer', creditPerCny: 10
  });
  assert.equal((await store.getSiteWithToken(saved.id)).accessToken, '');
});

test('extracts and deduplicates saved sites from existing price data', () => {
  const candidates = extractPublishedSiteCandidates({ entries: [
    { provider: 'Niko', relayAddress: 'https://niko.example/register', updatedAt: 1 },
    { provider: 'NikoAPI', relayAddress: 'https://niko.example/dashboard', updatedAt: 2 },
    { provider: 'NikoAPI', relayAddress: 'https://niko.example/sign-up', updatedAt: 3 },
    { provider: '另一个站 1:10充值', relayAddress: 'relay.example/path', updatedAt: 4 },
    { provider: '', relayAddress: 'https://ignored.example' },
    { provider: '坏地址', relayAddress: 'not a valid host %' }
  ] });
  assert.deepEqual(candidates, [
    { name: '另一个站 1:10充值', siteUrl: 'https://relay.example', entryCount: 1, creditPerCny: 10 },
    { name: 'NikoAPI', siteUrl: 'https://niko.example', entryCount: 3, creditPerCny: 1 }
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
        data: [{ model_name: 'gpt-5.6-sol', quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: [] }],
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

test('local fetch server only returns GPT 5.6 sol and Claude Fable 5 variants', async t => {
  const configDirectory = await mkdtemp(path.join(tmpdir(), 'ai-price-target-models-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  const sitesStore = new SavedSitesStore({ configDirectory });
  const app = createRatioFetchServer({
    sitesStore,
    fetchImpl: async () => jsonResponse({
      success: true,
      data: [
        { model_name: 'gpt-5.6-sol', quota_type: 0, model_ratio: 2.5, completion_ratio: 6 },
        { model_name: 'GPT 5.4', quota_type: 0, model_ratio: 1.25, completion_ratio: 6 },
        { model_name: 'claude-fable-5', quota_type: 0, model_ratio: 5, completion_ratio: 5 },
        { model_name: 'claude-sonnet-5', quota_type: 0, model_ratio: 1, completion_ratio: 5 }
      ],
      group_ratio: { default: 1 },
      usable_group: { default: '默认' }
    })
  });
  const origin = await app.listen();
  t.after(() => app.close());
  const savedResponse = await fetch(`${origin}/api/save-site`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '筛选站', siteUrl: 'https://filter.example' })
  });
  const saved = (await savedResponse.json()).site;
  const response = await fetch(`${origin}/api/fetch-sites`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteIds: [saved.id] })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(body.results[0].catalog.models.map(model => model.modelName), [
    'Claude Fable 5', 'GPT 5.6 sol'
  ]);
});

test('does not write a new snapshot file when every selected price is unchanged', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-price-no-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = {
    exportedAt: '2026-07-17T00:00:00.000Z', version: 2,
    entries: [{
      id: 'same', modelName: 'GPT 5.6 sol', category: 'GPT / OpenAI', provider: '测试站',
      relayAddress: 'https://same.example/register', useMultiplier: true, multiplier: 1,
      baseInputPrice: 5, baseCacheInputPrice: 5, baseOutputPrice: 30,
      createdAt: 1, updatedAt: 2
    }]
  };
  const app = createRatioFetchServer({
    snapshotResolver: async () => ({ filePath: path.join(directory, 'source.json'), snapshot, directory })
  });
  const origin = await app.listen();
  t.after(() => app.close());
  const response = await fetch(`${origin}/api/save-batch-snapshot`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{
      catalog: {
        baseUrl: 'https://same.example', groupRatio: { default: 1 }, usableGroup: { default: '默认' },
        models: [{
          modelName: 'gpt-5.6-sol', billingType: 'tokens', modelRatio: 2.5,
          completionRatio: 6, cacheRatio: 1, directInputUsd: null,
          directOutputUsd: null, directCacheUsd: null, enableGroups: []
        }]
      },
      selectedModels: ['gpt-5.6-sol'], group: 'default', exchangeRate: 1,
      creditPerCny: 1, provider: '测试站', categoryMode: 'auto'
    }] })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.outputName, null);
  assert.equal(body.updated, 0);
  assert.equal(body.added, 0);
  assert.equal(body.unchanged, 1);
  assert.deepEqual(body.changes, []);
  assert.deepEqual(await readdir(directory), []);
});

test('batch fetching separates sites waiting for a login token from real failures', async t => {
  const configDirectory = await mkdtemp(path.join(tmpdir(), 'ai-price-missing-token-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  const sitesStore = new SavedSitesStore({ configDirectory });
  const app = createRatioFetchServer({
    sitesStore,
    fetchImpl: async url => {
      const { hostname, pathname } = new URL(url);
      if (hostname === 'sub2.example' && pathname === '/api/v1/auth/me') {
        return jsonResponse({ code: 'UNAUTHORIZED', message: 'Authorization header is required' }, 401);
      }
      if (hostname === 'new-api.example' && pathname === '/api/pricing') {
        return jsonResponse({ message: 'Unauthorized, not logged in and no access token provided' }, 401);
      }
      return jsonResponse({ message: 'not found' }, 404);
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
    return (await response.json()).site;
  };
  const sub2 = await saveSite({ name: 'Sub2站', siteUrl: 'https://sub2.example' });
  const newApi = await saveSite({ name: 'New API站', siteUrl: 'https://new-api.example' });
  const response = await fetch(`${origin}/api/fetch-sites`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteIds: [sub2.id, newApi.id] })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results.map(result => result.reason), ['missing-token', 'missing-token']);
  assert.match(body.results[0].message, /Sub2API.*登录访问令牌/);
  assert.match(body.results[1].message, /New API.*登录访问令牌/);
});

test('local fetch UI offers direct token repair instead of counting it as a generic failure', async () => {
  const page = await readFile(path.join(PROJECT_ROOT, 'ratio-fetcher.html'), 'utf8');
  assert.match(page, /id="fetchAttention"/);
  assert.match(page, /待补令牌/);
  assert.match(page, /result\.reason === 'missing-token'/);
  assert.match(page, /result\.reason === 'invalid-token'/);
  assert.match(page, /openSiteEditor\(result\.site, \{ focusToken: true \}\)/);
  assert.match(page, /New API 可填写个人资料/);
  assert.match(page, /不是 sk- API Key/);
});
