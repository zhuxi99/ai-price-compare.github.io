import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { normalizeSiteUrl, RatioFetchError } from './ratio-fetch-core.mjs';

const STORE_VERSION = 1;
const SITE_TYPES = new Set(['auto', 'new-api', 'one-hub']);
const TOKEN_MODES = new Set(['bearer', 'raw']);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function publicSite(site) {
  return {
    id: site.id,
    name: site.name,
    siteUrl: site.siteUrl,
    userId: site.userId,
    siteType: site.siteType,
    tokenMode: site.tokenMode,
    creditPerCny: positiveNumber(site.creditPerCny),
    hasAccessToken: Boolean(site.accessTokenEncrypted?.data),
    createdAt: site.createdAt,
    updatedAt: site.updatedAt
  };
}

export class SavedSitesStore {
  constructor({ configDirectory = path.join(homedir(), '.config', 'ai-price-compare') } = {}) {
    this.configDirectory = configDirectory;
    this.storePath = path.join(configDirectory, 'ratio-sites.json');
    this.keyPath = path.join(configDirectory, '.ratio-sites.key');
  }

  async ensureDirectory() {
    await mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.configDirectory, 0o700);
  }

  async readStore() {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.sites)) {
        throw new RatioFetchError('本地站点库格式无效');
      }
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: STORE_VERSION, sites: [] };
      if (error instanceof RatioFetchError) throw error;
      throw new RatioFetchError('本地站点库无法读取');
    }
  }

  async writeStore(store) {
    await this.ensureDirectory();
    const temporaryPath = `${this.storePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.storePath);
    await chmod(this.storePath, 0o600);
  }

  async readKey() {
    await this.ensureDirectory();
    try {
      const key = await readFile(this.keyPath);
      if (key.length !== 32) throw new RatioFetchError('本地令牌密钥格式无效');
      return key;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      try {
        await writeFile(this.keyPath, key, { mode: 0o600, flag: 'wx' });
        return key;
      } catch (writeError) {
        if (writeError?.code === 'EEXIST') return this.readKey();
        throw writeError;
      }
    }
  }

  async encryptToken(token) {
    const value = cleanString(token);
    if (!value) return null;
    const key = await this.readKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  async decryptToken(payload) {
    if (!payload?.data) return '';
    try {
      const key = await this.readKey();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(payload.data, 'base64')),
        decipher.final()
      ]).toString('utf8');
    } catch {
      throw new RatioFetchError('保存的访问令牌无法解密，请重新编辑该站点');
    }
  }

  async listSites() {
    const store = await this.readStore();
    return store.sites.map(publicSite).sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN', { numeric: true })
    );
  }

  async saveSite(input) {
    const name = cleanString(input?.name);
    if (!name) throw new RatioFetchError('请填写站点名称');
    const siteUrl = normalizeSiteUrl(input?.siteUrl);
    const siteType = SITE_TYPES.has(input?.siteType) ? input.siteType : 'auto';
    const tokenMode = TOKEN_MODES.has(input?.tokenMode) ? input.tokenMode : 'bearer';
    const userId = cleanString(input?.userId);
    const accessToken = cleanString(input?.accessToken);
    const store = await this.readStore();
    const existingIndex = input?.id
      ? store.sites.findIndex(site => site.id === input.id)
      : -1;
    if (input?.id && existingIndex < 0) throw new RatioFetchError('要编辑的站点不存在');
    const existing = existingIndex >= 0 ? store.sites[existingIndex] : null;
    const duplicate = store.sites.find(site => site.siteUrl === siteUrl && site.id !== existing?.id);
    if (duplicate) throw new RatioFetchError(`站点地址已由「${duplicate.name}」保存`);

    let accessTokenEncrypted = existing?.accessTokenEncrypted ?? null;
    if (input?.clearAccessToken === true) accessTokenEncrypted = null;
    else if (accessToken) accessTokenEncrypted = await this.encryptToken(accessToken);

    const now = Date.now();
    const site = {
      id: existing?.id ?? randomUUID(),
      name,
      siteUrl,
      userId,
      siteType,
      tokenMode,
      creditPerCny: positiveNumber(input?.creditPerCny, positiveNumber(existing?.creditPerCny)),
      accessTokenEncrypted,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (existingIndex >= 0) store.sites[existingIndex] = site;
    else store.sites.push(site);
    await this.writeStore(store);
    return publicSite(site);
  }

  async importSites(inputs) {
    const store = await this.readStore();
    const sitesByUrl = new Map(store.sites.map(site => [site.siteUrl, site]));
    const matched = [];
    const added = [];
    const updated = [];
    let skipped = 0;

    for (const input of Array.isArray(inputs) ? inputs : []) {
      const name = cleanString(input?.name);
      let siteUrl;
      try {
        siteUrl = normalizeSiteUrl(input?.siteUrl);
      } catch {
        skipped += 1;
        continue;
      }
      if (!name) {
        skipped += 1;
        continue;
      }

      const existing = sitesByUrl.get(siteUrl);
      if (existing) {
        const inferredCredit = positiveNumber(input?.creditPerCny);
        if (existing.creditPerCny === undefined && inferredCredit > 1) {
          existing.creditPerCny = inferredCredit;
          existing.updatedAt = Date.now();
          updated.push(existing);
        }
        matched.push(existing);
        skipped += 1;
        continue;
      }

      const now = Date.now();
      const site = {
        id: randomUUID(),
        name,
        siteUrl,
        userId: '',
        siteType: 'auto',
        tokenMode: 'bearer',
        creditPerCny: positiveNumber(input?.creditPerCny),
        accessTokenEncrypted: null,
        createdAt: now,
        updatedAt: now
      };
      store.sites.push(site);
      sitesByUrl.set(siteUrl, site);
      matched.push(site);
      added.push(site);
    }

    if (added.length > 0 || updated.length > 0) await this.writeStore(store);
    return {
      sites: matched.map(publicSite),
      added: added.map(publicSite),
      updated: updated.map(publicSite),
      skipped
    };
  }

  async deleteSite(id) {
    const store = await this.readStore();
    const nextSites = store.sites.filter(site => site.id !== id);
    if (nextSites.length === store.sites.length) throw new RatioFetchError('要删除的站点不存在');
    await this.writeStore({ ...store, sites: nextSites });
  }

  async getSiteWithToken(id) {
    const store = await this.readStore();
    const site = store.sites.find(item => item.id === id);
    if (!site) throw new RatioFetchError('保存的站点不存在');
    return {
      ...publicSite(site),
      accessToken: await this.decryptToken(site.accessTokenEncrypted)
    };
  }
}
