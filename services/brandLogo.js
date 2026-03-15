const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../utils/logger');

const LOGO_DIR = path.join(__dirname, '../artifacts/logos');
const GITHUB_API = 'https://api.github.com';

function ensureLogoDir() {
  if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });
}

function getLogoStorageProvider() {
  return String(process.env.LOGO_STORAGE_PROVIDER || 'local').toLowerCase();
}

function normalizeDomain(domain = '') {
  return String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

function candidateBaseUrls(websiteUrl, domain) {
  const domainClean = normalizeDomain(domain || websiteUrl);
  const out = [];
  const push = (url) => {
    if (!url) return;
    if (!out.includes(url)) out.push(url);
  };
  if (websiteUrl) {
    push(String(websiteUrl).replace(/\/+$/, ''));
    push(String(websiteUrl).replace(/\/+$/, '').replace(/^http:\/\//i, 'https://'));
  }
  if (domainClean) {
    push(`https://${domainClean}`);
    push(`https://www.${domainClean}`);
    push(`http://${domainClean}`);
  }
  return out;
}

function looksLikeImageUrl(url = '') {
  return /^https?:\/\//i.test(url);
}

function extFromContentType(contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('image/svg')) return 'svg';
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/webp')) return 'webp';
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg';
  if (ct.includes('image/gif')) return 'gif';
  if (ct.includes('image/x-icon') || ct.includes('image/vnd.microsoft.icon')) return 'ico';
  return '';
}

function extFromUrl(url = '') {
  const clean = String(url || '').split('?')[0].toLowerCase();
  const m = clean.match(/\.(svg|png|webp|jpg|jpeg|gif|ico)$/i);
  if (!m) return '';
  return m[1] === 'jpeg' ? 'jpg' : m[1];
}

function hash(input = '') {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 10);
}

function extractCandidates(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const candidates = [];
  const add = (rawUrl, source, bonus = 0) => {
    if (!rawUrl) return;
    try {
      const absolute = new URL(rawUrl, pageUrl).toString();
      if (!looksLikeImageUrl(absolute)) return;
      candidates.push({ url: absolute, source, score: bonus });
    } catch {
      // ignore
    }
  };

  add($('meta[property="og:logo"]').attr('content'), 'meta:og:logo', 100);
  add($('meta[property="og:image"]').attr('content'), 'meta:og:image', 60);
  add($('meta[name="twitter:image"]').attr('content'), 'meta:twitter:image', 55);
  add($('link[rel="apple-touch-icon"]').attr('href'), 'link:apple-touch-icon', 40);
  add($('link[rel="icon"]').attr('href'), 'link:icon', 20);
  add($('link[rel="shortcut icon"]').attr('href'), 'link:shortcut-icon', 18);

  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!src) return;
    const attrs = `${$(el).attr('id') || ''} ${$(el).attr('class') || ''} ${$(el).attr('alt') || ''} ${src}`.toLowerCase();
    let bonus = 0;
    if (attrs.includes('logo')) bonus += 80;
    if (attrs.includes('brand')) bonus += 20;
    if (attrs.includes('favicon')) bonus -= 30;
    add(src, 'img', bonus);
  });

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text() || '';
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      const blocks = Array.isArray(parsed) ? parsed : [parsed];
      for (const block of blocks) {
        const logo = block?.logo?.url || block?.logo;
        if (typeof logo === 'string') add(logo, 'jsonld:logo', 95);
      }
    } catch {
      // ignore malformed jsonld
    }
  });

  const dedup = new Map();
  for (const c of candidates) {
    const key = c.url;
    const prev = dedup.get(key);
    if (!prev || c.score > prev.score) dedup.set(key, c);
  }

  const scored = Array.from(dedup.values()).map((c) => {
    const lower = c.url.toLowerCase();
    let score = c.score || 0;
    if (lower.includes('logo')) score += 30;
    if (lower.includes('favicon')) score -= 30;
    if (lower.includes('sprite')) score -= 20;
    if (lower.includes('icon-')) score -= 6;
    if (lower.endsWith('.svg')) score += 20;
    if (lower.endsWith('.png') || lower.endsWith('.webp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) score += 10;
    if (lower.endsWith('.ico')) score -= 15;
    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 12000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  return { url: res.request?.res?.responseUrl || url, html: String(res.data || '') };
}

async function fetchLogoBytes(url, domain) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 12000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': `https://${normalizeDomain(domain)}`
    }
  });
  const contentType = String(res.headers['content-type'] || '');
  const extByType = extFromContentType(contentType);
  const extByUrl = extFromUrl(url);
  const buffer = Buffer.from(res.data);
  const hasImageSignature = (
    (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) || // PNG
    (buffer[0] === 0xFF && buffer[1] === 0xD8) || // JPG
    (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) || // GIF
    (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) || // WEBP/RIFF
    String(buffer.slice(0, 120).toString('utf8')).toLowerCase().includes('<svg')
  );
  if (!contentType.toLowerCase().startsWith('image/') && !extByUrl && !hasImageSignature) {
    throw new Error(`Not an image payload: ${contentType}`);
  }
  const ext = extByType || extByUrl || 'png';
  return { buffer, contentType, ext };
}

async function saveLogoLocal({ buffer, domain, sourceUrl, ext }) {
  ensureLogoDir();
  const fileName = `${normalizeDomain(domain)}-${hash(sourceUrl)}.${ext}`;
  const filePath = path.join(LOGO_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  return { logoUrl: `/artifacts/logos/${fileName}`, filePath, provider: 'local' };
}

function githubConfig() {
  return {
    token: process.env.GITHUB_LOGO_TOKEN || process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_LOGO_OWNER || '',
    repo: process.env.GITHUB_LOGO_REPO || '',
    branch: process.env.GITHUB_LOGO_BRANCH || 'main',
    pathPrefix: String(process.env.GITHUB_LOGO_PATH_PREFIX || 'brand-logos').replace(/^\/+|\/+$/g, ''),
    publicBaseUrl: (process.env.GITHUB_LOGO_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  };
}

async function saveLogoGitHub({ buffer, domain, sourceUrl, ext }) {
  const cfg = githubConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    throw new Error('Missing GitHub logo storage configuration');
  }

  const fileName = `${normalizeDomain(domain)}-${hash(sourceUrl)}.${ext}`;
  const filePath = `${cfg.pathPrefix}/${fileName}`;
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(filePath)}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  let sha = null;
  try {
    const existing = await axios.get(`${url}?ref=${encodeURIComponent(cfg.branch)}`, { headers, timeout: 12000 });
    sha = existing?.data?.sha || null;
  } catch (err) {
    if (Number(err?.response?.status) !== 404) throw err;
  }

  await axios.put(url, {
    message: `chore(logos): upsert ${fileName}`,
    content: buffer.toString('base64'),
    branch: cfg.branch,
    ...(sha ? { sha } : {})
  }, { headers, timeout: 15000 });

  const logoUrl = cfg.publicBaseUrl
    ? `${cfg.publicBaseUrl}/${filePath}`
    : `https://cdn.jsdelivr.net/gh/${cfg.owner}/${cfg.repo}@${cfg.branch}/${filePath}`;
  return { logoUrl, filePath, provider: 'github' };
}

async function persistLogo({ buffer, domain, sourceUrl, ext }) {
  const provider = getLogoStorageProvider();
  if (provider === 'github') {
    return saveLogoGitHub({ buffer, domain, sourceUrl, ext });
  }
  return saveLogoLocal({ buffer, domain, sourceUrl, ext });
}

async function discoverLogoCandidate(websiteUrl, domain) {
  const bases = candidateBaseUrls(websiteUrl, domain);
  for (const base of bases) {
    try {
      const { url, html } = await fetchHtml(base);
      const candidates = extractCandidates(html, url);
      if (candidates.length) return { pageUrl: url, candidates };
    } catch {
      continue;
    }
  }
  return { pageUrl: null, candidates: [] };
}

async function ensureBrandLogo({ websiteUrl, domain, name, currentLogoUrl } = {}, { force = false } = {}) {
  if (!force && currentLogoUrl) return { ok: true, skipped: true, logoUrl: currentLogoUrl };
  const cleanDomain = normalizeDomain(domain || websiteUrl);
  if (!cleanDomain) return { ok: false, error: 'missing_domain' };

  try {
    const { candidates } = await discoverLogoCandidate(websiteUrl, cleanDomain);
    if (!candidates.length) return { ok: false, error: 'no_logo_candidate' };

    for (const candidate of candidates.slice(0, 8)) {
      try {
        const payload = await fetchLogoBytes(candidate.url, cleanDomain);
        const saved = await persistLogo({
          buffer: payload.buffer,
          domain: cleanDomain,
          sourceUrl: candidate.url,
          ext: payload.ext
        });
        return { ok: true, logoUrl: saved.logoUrl, sourceUrl: candidate.url, source: candidate.source, storage: saved.provider };
      } catch {
        continue;
      }
    }

    const fallback = candidates[0];
    return { ok: true, logoUrl: fallback.url, sourceUrl: fallback.url, source: `${fallback.source}:remote` };
  } catch (err) {
    logger.debug(`[logo] Failed for ${name || cleanDomain}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  ensureBrandLogo
};
