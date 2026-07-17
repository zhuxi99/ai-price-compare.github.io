const NEW_API_QUOTA_PRICE_USD_PER_MILLION = 2;
const LITELLM_MODEL_PRICE_TABLE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const liteLlmPriceTableCache = new WeakMap();
const TRACKED_MODEL_PATTERNS = [
  /gpt[\s._-]*5[._-]6[\s._-]*sol\b/i,
  /claude[\s._-]*fable[\s._-]*5\b/i
];

export class RatioFetchError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RatioFetchError';
    this.status = options.status;
    this.code = options.code;
  }
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeNumber(value, fallback = null) {
  const number = finiteNumber(value, fallback);
  return number !== null && number >= 0 ? number : fallback;
}

function positiveNumber(value, fallback = null) {
  const number = finiteNumber(value, fallback);
  return number !== null && number > 0 ? number : fallback;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isTrackedModelName(modelName) {
  const name = cleanString(modelName);
  return TRACKED_MODEL_PATTERNS.some(pattern => pattern.test(name));
}

export function filterTrackedModels(catalog) {
  const models = (Array.isArray(catalog?.models) ? catalog.models : [])
    .filter(model => isTrackedModelName(model?.modelName))
    .sort((left, right) => left.modelName.localeCompare(right.modelName, 'zh-CN', { numeric: true }));
  if (models.length === 0) {
    throw new RatioFetchError('该站点没有返回 GPT 5.6 sol 或 Claude Fable 5 模型', {
      code: 'no-target-model'
    });
  }
  return { ...catalog, models };
}

function cleanScalar(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeSiteUrl(value) {
  const input = cleanString(value);
  if (!input) throw new RatioFetchError('请填写目标站点地址');

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new RatioFetchError('目标站点地址格式不正确');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RatioFetchError('目标站点只支持 HTTP 或 HTTPS');
  }
  if (url.username || url.password) {
    throw new RatioFetchError('目标站点地址不能包含用户名或密码');
  }

  return url.origin;
}

export function buildAccessHeaders({ accessToken = '', userId = '', tokenMode = 'bearer' } = {}) {
  const headers = { Accept: 'application/json' };
  const token = cleanString(accessToken).replace(/^Bearer\s+/i, '');
  if (token) {
    headers.Authorization = tokenMode === 'raw' ? token : `Bearer ${token}`;
  }

  const normalizedUserId = cleanString(userId);
  if (normalizedUserId) {
    for (const name of [
      'New-API-User',
      'Veloera-User',
      'X-Api-User',
      'voapi-user',
      'User-id',
      'Rix-Api-User',
      'neo-api-user'
    ]) {
      headers[name] = normalizedUserId;
    }
  }
  return headers;
}

async function readResponseMessage(response) {
  try {
    const body = await response.clone().json();
    for (const value of [body?.message, body?.msg, body?.error?.message]) {
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 240);
    }
  } catch {
    // Upstream error bodies are frequently HTML; do not expose them in the UI.
  }
  return '';
}

async function fetchJson(fetchImpl, url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) {
      const upstreamMessage = await readResponseMessage(response);
      throw new RatioFetchError(
        upstreamMessage || `目标站点返回 HTTP ${response.status}`,
        { status: response.status }
      );
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/json/i.test(contentType)) {
      throw new RatioFetchError('目标接口没有返回 JSON，可能被登录页或防护页面拦截');
    }
    try {
      return await response.json();
    } catch {
      throw new RatioFetchError('目标接口返回的 JSON 无法解析');
    }
  } catch (error) {
    const networkCode = error?.cause?.code || error?.cause?.cause?.code || '';
    if (error?.name === 'AbortError' || /TIMEOUT/i.test(networkCode)) {
      throw new RatioFetchError('连接目标站点超时');
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(networkCode)) {
      throw new RatioFetchError('目标站点域名暂时无法解析');
    }
    if (/CERT|TLS|SSL/i.test(networkCode)) {
      throw new RatioFetchError('目标站点的 HTTPS 证书或 TLS 连接异常');
    }
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(networkCode)) {
      throw new RatioFetchError('目标站点拒绝连接或网络不可达');
    }
    if (error instanceof RatioFetchError) throw error;
    throw new RatioFetchError(`无法连接目标站点：${error?.message || '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
}

function unwrapEnvelope(payload) {
  if (!isRecord(payload)) return payload;
  if (isRecord(payload.data) && typeof payload.success === 'boolean') return payload.data;
  return payload;
}

async function probeSub2Api(fetchImpl, baseUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/auth/me`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!/json/i.test(response.headers.get('content-type') || '')) return false;
    const payload = await response.json();
    return isRecord(payload)
      && (typeof payload.code === 'string' || payload.code === 0)
      && ('message' in payload || 'data' in payload);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function unwrapSub2Api(payload, endpoint) {
  if (!isRecord(payload) || payload.code !== 0 || !('data' in payload)) {
    const message = cleanString(payload?.message ?? payload?.msg);
    throw new RatioFetchError(message || `Sub2API 的 ${endpoint} 返回格式不兼容`);
  }
  return payload.data;
}

function sub2Items(payload) {
  if (Array.isArray(payload)) return payload;
  return isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
}

function parseRuntimeModelIds(payload) {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  return rows.map(row => cleanString(isRecord(row) ? row.id ?? row.model : row)).filter(Boolean);
}

function normalizeLiteLlmPriceTable(payload) {
  if (!isRecord(payload)) throw new RatioFetchError('官方模型价格表格式无效');
  const prices = new Map();
  for (const [modelName, value] of Object.entries(payload)) {
    if (!isRecord(value) || modelName === 'sample_spec') continue;
    const input = nonNegativeNumber(value.input_cost_per_token, null);
    const output = nonNegativeNumber(value.output_cost_per_token, null);
    if (input === null || output === null) continue;
    prices.set(modelName, {
      input: input * 1_000_000,
      output: output * 1_000_000,
      cache: nonNegativeNumber(value.cache_read_input_token_cost, null) === null
        ? null
        : Number(value.cache_read_input_token_cost) * 1_000_000
    });
  }
  return prices;
}

async function loadLiteLlmPriceTable(fetchImpl, timeoutMs) {
  if (!liteLlmPriceTableCache.has(fetchImpl)) {
    const request = fetchJson(fetchImpl, LITELLM_MODEL_PRICE_TABLE_URL, { Accept: 'application/json' }, timeoutMs)
      .then(normalizeLiteLlmPriceTable)
      .catch(error => {
        liteLlmPriceTableCache.delete(fetchImpl);
        throw error;
      });
    liteLlmPriceTableCache.set(fetchImpl, request);
  }
  return liteLlmPriceTableCache.get(fetchImpl);
}

async function fetchSub2ApiCatalog({ baseUrl, accessToken, timeoutMs, fetchImpl }) {
  const token = cleanString(accessToken).replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new RatioFetchError('已识别为 Sub2API，请填写该站点的登录访问令牌（JWT）', {
      code: 'missing-token'
    });
  }
  const dashboardHeaders = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  let groupsPayload;
  let ratesPayload;
  let keysPayload;
  let officialPrices;
  try {
    [groupsPayload, ratesPayload, keysPayload, officialPrices] = await Promise.all([
      fetchJson(fetchImpl, `${baseUrl}/api/v1/groups/available`, dashboardHeaders, timeoutMs),
      fetchJson(fetchImpl, `${baseUrl}/api/v1/groups/rates`, dashboardHeaders, timeoutMs),
      fetchJson(fetchImpl, `${baseUrl}/api/v1/keys?page=1&page_size=100`, dashboardHeaders, timeoutMs),
      loadLiteLlmPriceTable(fetchImpl, timeoutMs)
    ]);
  } catch (error) {
    if (error?.status === 401) {
      throw new RatioFetchError('Sub2API 登录令牌无效或已过期，请填写网页登录 JWT（不是 sk- API Key）', {
        code: 'invalid-token'
      });
    }
    throw error;
  }
  const groups = sub2Items(unwrapSub2Api(groupsPayload, '/api/v1/groups/available'));
  const rates = unwrapSub2Api(ratesPayload, '/api/v1/groups/rates');
  const keys = sub2Items(unwrapSub2Api(keysPayload, '/api/v1/keys'))
    .filter(key => isRecord(key) && cleanString(key.key) && !/inactive|disabled|expired/i.test(cleanString(key.status)))
    .slice(0, 20);
  if (keys.length === 0) throw new RatioFetchError('Sub2API 账号没有可用的 API Key，请先在站点控制台创建一个');

  const groupById = new Map();
  const groupRatio = {};
  const usableGroup = {};
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const id = cleanScalar(group.id);
    const name = cleanString(group.name);
    if (!id || !name) continue;
    const ratio = positiveNumber(isRecord(rates) ? rates[id] : null, positiveNumber(group.rate_multiplier, 1));
    groupById.set(id, name);
    groupRatio[name] = ratio;
    usableGroup[name] = name;
  }

  const modelGroups = new Map();
  const runtimeResults = await Promise.allSettled(keys.map(async key => {
    const apiKey = cleanString(key.key).replace(/^Bearer\s+/i, '');
    const groupId = cleanScalar(key.group_id ?? key.group?.id ?? key.Group?.id);
    const groupName = groupById.get(groupId)
      || cleanString(key.group?.name ?? key.Group?.name)
      || 'default';
    if (!Object.hasOwn(groupRatio, groupName)) {
      groupRatio[groupName] = 1;
      usableGroup[groupName] = groupName;
    }
    const runtimePayload = await fetchJson(fetchImpl, `${baseUrl}/v1/models`, {
      Accept: 'application/json', Authorization: `Bearer ${apiKey}`
    }, timeoutMs);
    for (const modelName of parseRuntimeModelIds(runtimePayload)) {
      if (!modelGroups.has(modelName)) modelGroups.set(modelName, new Set());
      modelGroups.get(modelName).add(groupName);
    }
  }));
  if (runtimeResults.every(result => result.status === 'rejected')) {
    throw new RatioFetchError('Sub2API 的 API Key 均无法读取模型，请在站点控制台检查 Key 是否有效');
  }

  const models = [...modelGroups.entries()].flatMap(([modelName, enabled]) => {
    const price = officialPrices.get(modelName);
    if (!price) return [];
    return [{
      modelName,
      quotaType: 0,
      modelRatio: price.input / NEW_API_QUOTA_PRICE_USD_PER_MILLION,
      completionRatio: price.input > 0 ? price.output / price.input : 1,
      cacheRatio: price.cache === null || price.input <= 0 ? null : price.cache / price.input,
      directInputUsd: price.input,
      directOutputUsd: price.output,
      directCacheUsd: price.cache,
      enableGroups: [...enabled],
      owner: '',
      billingType: 'tokens'
    }];
  }).sort((left, right) => left.modelName.localeCompare(right.modelName, 'zh-CN', { numeric: true }));
  if (models.length === 0) {
    throw new RatioFetchError('Sub2API 已读取模型，但官方价格表没有匹配项，暂时无法估算价格');
  }
  return { sourceType: 'sub2api', models, groupRatio, usableGroup };
}

function normalizeGroupMaps(groupRatioValue, usableGroupValue) {
  const groupRatio = {};
  const usableGroup = {};
  const rawRatios = isRecord(groupRatioValue) ? groupRatioValue : {};
  const rawLabels = isRecord(usableGroupValue) ? usableGroupValue : {};

  for (const [key, value] of Object.entries(rawRatios)) {
    const ratio = positiveNumber(value);
    if (ratio !== null) groupRatio[key] = ratio;
  }
  for (const [key, value] of Object.entries(rawLabels)) {
    if (typeof value === 'string' && value.trim()) usableGroup[key] = value.trim();
  }
  if (Object.keys(groupRatio).length === 0) groupRatio.default = 1;
  for (const key of Object.keys(groupRatio)) {
    if (!usableGroup[key]) usableGroup[key] = key === 'default' ? '默认分组' : key;
  }
  return { groupRatio, usableGroup };
}

function normalizeNewApiPricing(payload) {
  const response = unwrapEnvelope(payload);
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new RatioFetchError('该站点的 /api/pricing 返回格式不兼容');
  }

  const models = response.data.map((row) => {
    if (!isRecord(row)) return null;
    const modelName = cleanString(row.model_name ?? row.model);
    if (!modelName) return null;
    const direct = isRecord(row.token_price_usd_per_million)
      ? row.token_price_usd_per_million
      : {};
    return {
      modelName,
      quotaType: finiteNumber(row.quota_type, 0),
      modelRatio: nonNegativeNumber(row.model_ratio, 0),
      completionRatio: nonNegativeNumber(row.completion_ratio, 1),
      cacheRatio: nonNegativeNumber(row.cache_ratio, null),
      directInputUsd: nonNegativeNumber(direct.input, null),
      directOutputUsd: nonNegativeNumber(direct.output, null),
      directCacheUsd: nonNegativeNumber(direct.cache_read, null),
      enableGroups: Array.isArray(row.enable_groups)
        ? row.enable_groups.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
        : [],
      owner: cleanString(row.owner_by ?? row.vendor_name),
      billingType: finiteNumber(row.quota_type, 0) === 0 ? 'tokens' : 'times'
    };
  }).filter(Boolean);

  if (models.length === 0) throw new RatioFetchError('倍率接口没有返回可识别的模型');
  const groups = normalizeGroupMaps(response.group_ratio, response.usable_group);
  return { sourceType: 'new-api', models, ...groups };
}

function normalizeOneHubPricing(availablePayload, groupPayload) {
  const availableModels = unwrapEnvelope(availablePayload);
  const groupsPayload = unwrapEnvelope(groupPayload);
  if (!isRecord(availableModels) || Array.isArray(availableModels)) {
    throw new RatioFetchError('该站点的 /api/available_model 返回格式不兼容');
  }

  const models = Object.entries(availableModels).map(([name, value]) => {
    if (!isRecord(value) || !isRecord(value.price)) return null;
    const modelName = cleanString(name);
    const input = positiveNumber(value.price.input, 1);
    const output = nonNegativeNumber(value.price.output, input);
    return {
      modelName,
      quotaType: value.price.type === 'times' ? 1 : 0,
      modelRatio: 1,
      completionRatio: input ? output / input : 1,
      cacheRatio: null,
      directInputUsd: null,
      directOutputUsd: null,
      directCacheUsd: null,
      enableGroups: Array.isArray(value.groups)
        ? value.groups.filter(group => typeof group === 'string' && group.trim()).map(group => group.trim())
        : [],
      owner: cleanString(value.owned_by),
      billingType: value.price.type === 'times' ? 'times' : 'tokens'
    };
  }).filter(Boolean);

  if (models.length === 0) throw new RatioFetchError('One Hub 接口没有返回可识别的模型');
  const rawGroupRatios = {};
  const rawGroupLabels = {};
  if (isRecord(groupsPayload)) {
    for (const [key, group] of Object.entries(groupsPayload)) {
      if (!isRecord(group)) continue;
      rawGroupRatios[key] = group.ratio;
      rawGroupLabels[key] = cleanString(group.name) || key;
    }
  }
  const groups = normalizeGroupMaps(rawGroupRatios, rawGroupLabels);
  return { sourceType: 'one-hub', models, ...groups };
}

export async function fetchRatioCatalog({
  siteUrl,
  accessToken = '',
  userId = '',
  tokenMode = 'bearer',
  siteType = 'auto',
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') throw new RatioFetchError('当前 Node.js 不支持网络请求');
  const baseUrl = normalizeSiteUrl(siteUrl);
  const headers = buildAccessHeaders({ accessToken, userId, tokenMode });
  const errors = [];
  let newApiAuthFailed = false;
  let newApiBlocked = false;
  let oneHubBlocked = false;

  if (siteType === 'auto' || siteType === 'new-api') {
    try {
      const payload = await fetchJson(fetchImpl, `${baseUrl}/api/pricing`, headers, timeoutMs);
      return { baseUrl, ...normalizeNewApiPricing(payload) };
    } catch (error) {
      newApiAuthFailed = error?.status === 401;
      newApiBlocked = error?.status === 403;
      if (siteType === 'new-api') {
        if (newApiAuthFailed) {
          const hasToken = Boolean(cleanString(accessToken));
          throw new RatioFetchError(hasToken
            ? 'New API 登录令牌已失效或过期，请重新填写'
            : '已识别为 New API，请填写该站点的登录访问令牌', {
            code: hasToken ? 'invalid-token' : 'missing-token'
          });
        }
        throw error;
      }
      errors.push(`New API：${error.message}`);
    }
  }

  if (siteType === 'auto' || siteType === 'sub2api') {
    const detected = siteType === 'sub2api'
      || await probeSub2Api(fetchImpl, baseUrl, Math.min(timeoutMs, 8_000));
    if (detected) {
      try {
        return { baseUrl, ...await fetchSub2ApiCatalog({ baseUrl, accessToken, timeoutMs, fetchImpl }) };
      } catch (error) {
        if (siteType === 'sub2api' || error?.code || /登录访问令牌|API Key/.test(error.message)) throw error;
        errors.push(`Sub2API：${error.message}`);
      }
    }
  }

  if (siteType === 'auto' || siteType === 'one-hub') {
    try {
      const [available, groups] = await Promise.all([
        fetchJson(fetchImpl, `${baseUrl}/api/available_model`, headers, timeoutMs),
        fetchJson(fetchImpl, `${baseUrl}/api/user_group_map`, headers, timeoutMs)
      ]);
      return { baseUrl, ...normalizeOneHubPricing(available, groups) };
    } catch (error) {
      oneHubBlocked = error?.status === 403;
      if (siteType === 'one-hub') throw error;
      errors.push(`One Hub：${error.message}`);
    }
  }

  if (newApiAuthFailed) {
    const hasToken = Boolean(cleanString(accessToken));
    throw new RatioFetchError(hasToken
      ? 'New API 登录令牌已失效或过期，请重新填写'
      : '已识别为 New API，请填写该站点的登录访问令牌', {
      code: hasToken ? 'invalid-token' : 'missing-token'
    });
  }

  if (newApiBlocked && oneHubBlocked) {
    throw new RatioFetchError('目标站点拒绝服务器抓取（HTTP 403，通常是 Cloudflare/WAF 防护），暂时无法自动读取', {
      code: 'access-blocked'
    });
  }

  throw new RatioFetchError(`未识别出兼容站点。${errors.join('；')}`);
}

const MODEL_FAMILIES = [
  { category: 'GPT / OpenAI', patterns: [/\bgpt[-_.\s]?/i, /\bo[134](?:[-_.\s]|$)/i, /codex/i, /chatgpt/i] },
  { category: 'Claude', patterns: [/claude/i, /fable/i] },
  { category: 'Gemini', patterns: [/gemini/i, /gemma/i] },
  { category: 'DeepSeek', patterns: [/deepseek/i] },
  { category: '通义千问 Qwen', patterns: [/qwen/i, /qwq/i, /通义/i] },
  { category: '智谱 GLM', patterns: [/\bglm/i, /chatglm/i, /智谱/i] },
  { category: 'Kimi / Moonshot', patterns: [/kimi/i, /moonshot/i] },
  { category: '豆包 Doubao', patterns: [/doubao/i, /豆包/i] },
  { category: 'MiniMax', patterns: [/minimax/i, /abab/i] },
  { category: 'Grok', patterns: [/\bgrok/i] },
  { category: 'Llama / Meta', patterns: [/llama/i, /\bmeta[-_.\s]/i] },
  { category: 'Mistral', patterns: [/mistral/i, /mixtral/i, /codestral/i] },
  { category: 'Yi / 零一万物', patterns: [/(^|[-_.\s])yi[-_.\s]/i, /零一万物/i] },
  { category: '图像生成', patterns: [/dall[-_.\s]?e/i, /midjourney/i, /flux/i, /stable[-_.\s]?diffusion/i, /imagen/i, /image/i] },
  { category: '视频生成', patterns: [/sora/i, /veo/i, /kling/i, /可灵/i, /video/i, /wan[-_.\s]?2/i] },
  { category: '语音与音频', patterns: [/whisper/i, /tts/i, /speech/i, /audio/i, /suno/i] },
  { category: '向量与重排', patterns: [/embedding/i, /embed/i, /rerank/i, /bge[-_.\s]/i] }
];

export function classifyModel(modelName) {
  const name = cleanString(modelName);
  const match = MODEL_FAMILIES.find(family => family.patterns.some(pattern => pattern.test(name)));
  return match?.category || '其他模型';
}

export const CATEGORY_PRIORITY = [
  '推荐', 'GPT / OpenAI', 'Claude', 'Gemini', 'DeepSeek', '通义千问 Qwen',
  '智谱 GLM', 'Kimi / Moonshot', '豆包 Doubao', 'MiniMax', 'Grok',
  'Llama / Meta', 'Mistral', 'Yi / 零一万物', '图像生成', '视频生成',
  '语音与音频', '向量与重排', '其他模型'
];

export function categoryRank(category) {
  const name = cleanString(category).toLowerCase();
  const index = CATEGORY_PRIORITY.findIndex(value => name.includes(value.toLowerCase()));
  return index === -1 ? CATEGORY_PRIORITY.length - 1 : index;
}

export function calculateModelPrices(model, exchangeRate, groupRatio) {
  const rate = positiveNumber(exchangeRate);
  const multiplier = positiveNumber(groupRatio);
  if (rate === null) throw new RatioFetchError('美元汇率必须大于 0');
  if (multiplier === null) throw new RatioFetchError('分组倍率必须大于 0');
  if (model?.billingType !== 'tokens') return null;

  const baseInputUsd = nonNegativeNumber(model.directInputUsd, null)
    ?? nonNegativeNumber(model.modelRatio, 0) * NEW_API_QUOTA_PRICE_USD_PER_MILLION;
  const baseOutputUsd = nonNegativeNumber(model.directOutputUsd, null)
    ?? baseInputUsd * nonNegativeNumber(model.completionRatio, 1);
  const baseCacheUsd = nonNegativeNumber(model.directCacheUsd, null)
    ?? baseInputUsd * nonNegativeNumber(model.cacheRatio, 1);

  return {
    baseInputPrice: baseInputUsd * rate,
    baseCacheInputPrice: baseCacheUsd * rate,
    baseOutputPrice: baseOutputUsd * rate,
    actualInputPrice: baseInputUsd * rate * multiplier,
    actualCacheInputPrice: baseCacheUsd * rate * multiplier,
    actualOutputPrice: baseOutputUsd * rate * multiplier
  };
}

function sameSite(left, right) {
  try {
    return new URL(left).origin.toLowerCase() === new URL(right).origin.toLowerCase();
  } catch {
    return false;
  }
}

export function mergeCatalogIntoSnapshot({
  snapshot,
  catalog,
  selectedModels,
  group = 'default',
  exchangeRate,
  creditPerCny = 1,
  provider,
  categoryMode = 'auto',
  fixedCategory = '自动抓取'
}) {
  if (!snapshot || !Array.isArray(snapshot.entries)) throw new RatioFetchError('现有价格 JSON 格式无效');
  if (!catalog || !Array.isArray(catalog.models)) throw new RatioFetchError('抓取结果格式无效');
  const providerName = cleanString(provider) || new URL(catalog.baseUrl).hostname;
  const fixedCategoryName = cleanString(fixedCategory) || `${providerName} 自动抓取`;
  const selected = new Set(Array.isArray(selectedModels) ? selectedModels : []);
  const groupRatio = positiveNumber(catalog.groupRatio?.[group], 1);
  const normalizedCreditPerCny = positiveNumber(creditPerCny, 1);
  const cnyPerUsdCredit = positiveNumber(exchangeRate, 1 / normalizedCreditPerCny);
  const now = Date.now();
  const nextEntries = snapshot.entries.map(entry => ({ ...entry }));
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const model of catalog.models) {
    if (!selected.has(model.modelName)) continue;
    if (model.billingType !== 'tokens') {
      skipped += 1;
      continue;
    }
    if (model.enableGroups.length > 0 && !model.enableGroups.includes(group)) {
      skipped += 1;
      continue;
    }
    const prices = calculateModelPrices(model, cnyPerUsdCredit, groupRatio);
    const category = categoryMode === 'fixed' ? fixedCategoryName : classifyModel(model.modelName);
    const entryData = {
      modelName: model.modelName,
      category,
      provider: providerName,
      relayAddress: catalog.baseUrl,
      useMultiplier: true,
      multiplier: groupRatio,
      baseInputPrice: prices.baseInputPrice,
      baseCacheInputPrice: prices.baseCacheInputPrice,
      baseOutputPrice: prices.baseOutputPrice,
      updatedAt: now
    };
    const index = nextEntries.findIndex(entry =>
      cleanString(entry.modelName).toLowerCase() === model.modelName.toLowerCase()
      && sameSite(entry.relayAddress, catalog.baseUrl)
    );
    if (index >= 0) {
      nextEntries[index] = { ...nextEntries[index], ...entryData };
      updated += 1;
    } else {
      nextEntries.push({ id: `${now}-${added}-${Math.random().toString(36).slice(2, 10)}`, ...entryData, createdAt: now });
      added += 1;
    }
  }

  return {
    snapshot: {
      exportedAt: new Date().toISOString(),
      version: 2,
      entries: nextEntries
    },
    added,
    updated,
    skipped,
    selected: selected.size
  };
}
