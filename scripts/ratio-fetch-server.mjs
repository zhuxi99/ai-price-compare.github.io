import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findLatestSnapshot } from './deploy-data.mjs';
import {
  fetchRatioCatalog,
  mergeCatalogIntoSnapshot,
  normalizeSiteUrl,
  RatioFetchError
} from './ratio-fetch-core.mjs';
import { SavedSitesStore } from './saved-sites-store.mjs';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_PATH = path.join(PROJECT_ROOT, 'ratio-fetcher.html');

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(JSON.stringify(body));
}

function pageResponse(response, html) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  });
  response.end(html);
}

async function readJsonBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
    throw new RatioFetchError('请求格式必须是 JSON');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RatioFetchError('请求数据过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RatioFetchError('请求 JSON 无法解析');
  }
}

async function resolveLatestSnapshot() {
  const directories = [path.join(homedir(), '下载'), path.join(homedir(), 'Downloads')];
  for (const directory of directories) {
    try {
      const filePath = await findLatestSnapshot(directory);
      return { filePath, snapshot: JSON.parse(await readFile(filePath, 'utf8')), directory };
    } catch (error) {
      if (error?.code !== 'ENOENT' && !String(error?.message).startsWith('没有找到有效且非空')) throw error;
    }
  }

  const publishedPage = await readFile(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
  const match = publishedPage.match(/const PUBLISHED_DATA = (\{.*?\}); \/\/ __PUBLISHED_DATA__/s);
  if (!match) throw new RatioFetchError('没有找到可合并的价格 JSON 或已发布数据');
  return {
    filePath: path.join(PROJECT_ROOT, 'index.html'),
    snapshot: JSON.parse(match[1]),
    directory: directories[0]
  };
}

export function extractPublishedSiteCandidates(snapshot) {
  const grouped = new Map();
  for (const entry of Array.isArray(snapshot?.entries) ? snapshot.entries : []) {
    const provider = typeof entry?.provider === 'string' ? entry.provider.trim() : '';
    if (!provider || !entry?.relayAddress) continue;
    let siteUrl;
    try {
      siteUrl = new URL(normalizeSiteUrl(entry.relayAddress));
    } catch {
      continue;
    }
    let group = grouped.get(siteUrl.origin);
    if (!group) {
      group = { siteUrl: siteUrl.origin, names: new Map(), totalEntries: 0 };
      grouped.set(siteUrl.origin, group);
    }
    const name = group.names.get(provider) || { count: 0, latest: 0 };
    name.count += 1;
    name.latest = Math.max(name.latest, Number(entry.updatedAt) || Number(entry.createdAt) || 0);
    group.names.set(provider, name);
    group.totalEntries += 1;
  }

  return [...grouped.values()].map(group => {
    const [name] = [...group.names.entries()].sort((left, right) =>
      right[1].count - left[1].count
      || right[1].latest - left[1].latest
      || left[0].localeCompare(right[0], 'zh-CN', { numeric: true })
    )[0];
    return { name, siteUrl: group.siteUrl, entryCount: group.totalEntries };
  }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
}

function safeFileTimestamp(date = new Date()) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join('');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${parts.join('-')}-${time}${milliseconds}`;
}

function publicCatalog(catalog) {
  return {
    baseUrl: catalog.baseUrl,
    sourceType: catalog.sourceType,
    groupRatio: catalog.groupRatio,
    usableGroup: catalog.usableGroup,
    models: catalog.models
  };
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function createRatioFetchServer({
  fetchImpl = globalThis.fetch,
  sitesStore = new SavedSitesStore(),
  snapshotResolver = resolveLatestSnapshot
} = {}) {
  let serverOrigin = '';
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', serverOrigin || `http://${HOST}`);
      if (request.method === 'GET' && url.pathname === '/') {
        return pageResponse(response, await readFile(PAGE_PATH, 'utf8'));
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const latest = await snapshotResolver();
        return jsonResponse(response, 200, {
          ok: true,
          entryCount: latest.snapshot.entries.length,
          exportedAt: latest.snapshot.exportedAt,
          sourceName: path.basename(latest.filePath)
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/sites') {
        return jsonResponse(response, 200, { ok: true, sites: await sitesStore.listSites() });
      }

      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin !== serverOrigin) return jsonResponse(response, 403, { ok: false, message: '拒绝非本地工具发起的请求' });
      }

      if (request.method === 'POST' && url.pathname === '/api/fetch-ratios') {
        const body = await readJsonBody(request);
        const catalog = await fetchRatioCatalog({
          siteUrl: body.siteUrl,
          accessToken: body.accessToken,
          userId: body.userId,
          tokenMode: body.tokenMode,
          siteType: body.siteType,
          fetchImpl
        });
        return jsonResponse(response, 200, { ok: true, catalog: publicCatalog(catalog) });
      }

      if (request.method === 'POST' && url.pathname === '/api/save-site') {
        const body = await readJsonBody(request);
        const site = await sitesStore.saveSite(body);
        return jsonResponse(response, 200, { ok: true, site });
      }

      if (request.method === 'POST' && url.pathname === '/api/delete-site') {
        const body = await readJsonBody(request);
        await sitesStore.deleteSite(body.id);
        return jsonResponse(response, 200, { ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/api/import-sites') {
        await readJsonBody(request);
        const latest = await snapshotResolver();
        const candidates = extractPublishedSiteCandidates(latest.snapshot);
        const imported = await sitesStore.importSites(candidates);
        return jsonResponse(response, 200, {
          ok: true,
          sourceName: path.basename(latest.filePath),
          recognized: candidates.length,
          imported: imported.added.length,
          skipped: imported.skipped,
          sites: imported.sites,
          addedSites: imported.added
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/fetch-sites') {
        const body = await readJsonBody(request);
        const siteIds = [...new Set(Array.isArray(body.siteIds) ? body.siteIds : [])]
          .filter(id => typeof id === 'string' && id);
        if (siteIds.length === 0) throw new RatioFetchError('请至少选择一个站点');
        if (siteIds.length > 50) throw new RatioFetchError('单次最多抓取 50 个站点');
        const sites = await Promise.all(siteIds.map(id => sitesStore.getSiteWithToken(id)));
        const results = await mapWithConcurrency(sites, 3, async site => {
          try {
            const catalog = await fetchRatioCatalog({
              siteUrl: site.siteUrl,
              accessToken: site.accessToken,
              userId: site.userId,
              tokenMode: site.tokenMode,
              siteType: site.siteType,
              fetchImpl
            });
            return {
              ok: true,
              site: { ...site, accessToken: undefined },
              catalog: publicCatalog(catalog)
            };
          } catch (error) {
            return {
              ok: false,
              site: { ...site, accessToken: undefined },
              message: error instanceof RatioFetchError ? error.message : '抓取失败'
            };
          }
        });
        return jsonResponse(response, 200, { ok: true, results });
      }

      if (request.method === 'POST' && url.pathname === '/api/save-snapshot') {
        const body = await readJsonBody(request);
        const latest = await snapshotResolver();
        const result = mergeCatalogIntoSnapshot({
          snapshot: latest.snapshot,
          catalog: body.catalog,
          selectedModels: body.selectedModels,
          group: body.group,
          exchangeRate: body.exchangeRate,
          provider: body.provider,
          categoryMode: body.categoryMode,
          fixedCategory: body.fixedCategory
        });
        const outputPath = path.join(latest.directory, `ai-price-data-${safeFileTimestamp()}.json`);
        await mkdir(latest.directory, { recursive: true });
        await writeFile(outputPath, `${JSON.stringify(result.snapshot, null, 2)}\n`, { mode: 0o600 });
        return jsonResponse(response, 200, {
          ok: true,
          outputName: path.basename(outputPath),
          entryCount: result.snapshot.entries.length,
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
          selected: result.selected
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/save-batch-snapshot') {
        const body = await readJsonBody(request);
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) throw new RatioFetchError('没有可保存的抓取结果');
        if (items.length > 50) throw new RatioFetchError('单次最多合并 50 个站点');
        const latest = await snapshotResolver();
        let snapshot = latest.snapshot;
        const totals = { added: 0, updated: 0, skipped: 0, selected: 0 };
        for (const item of items) {
          const result = mergeCatalogIntoSnapshot({
            snapshot,
            catalog: item.catalog,
            selectedModels: item.selectedModels,
            group: item.group,
            exchangeRate: item.exchangeRate,
            provider: item.provider,
            categoryMode: item.categoryMode,
            fixedCategory: item.fixedCategory
          });
          snapshot = result.snapshot;
          for (const key of Object.keys(totals)) totals[key] += result[key];
        }
        const outputPath = path.join(latest.directory, `ai-price-data-${safeFileTimestamp()}.json`);
        await mkdir(latest.directory, { recursive: true });
        await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
        return jsonResponse(response, 200, {
          ok: true,
          outputName: path.basename(outputPath),
          entryCount: snapshot.entries.length,
          ...totals
        });
      }

      jsonResponse(response, 404, { ok: false, message: '接口不存在' });
    } catch (error) {
      const message = error instanceof RatioFetchError
        ? error.message
        : '本地工具发生错误，请查看启动窗口';
      if (!(error instanceof RatioFetchError)) console.error(error);
      jsonResponse(response, error?.status && error.status >= 400 ? 502 : 400, { ok: false, message });
    }
  });

  return {
    server,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, resolve);
      });
      const address = server.address();
      serverOrigin = `http://${HOST}:${address.port}`;
      return serverOrigin;
    },
    close() {
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

async function main() {
  const app = createRatioFetchServer();
  const origin = await app.listen();
  console.log('AI 价格比对 - 本地倍率抓取工具');
  console.log('================================');
  console.log(`本地地址：${origin}`);
  console.log('保存的令牌使用本机 AES-256-GCM 密钥加密，不会进入价格 JSON。');
  console.log('完成后可在此窗口按 Ctrl+C 关闭工具。');

  if (process.argv.includes('--open')) {
    const child = spawn('xdg-open', [origin], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
