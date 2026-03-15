const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { chromium } = require('playwright');
const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const logger = require('../utils/logger');
const { markEmailActivity } = require('./gmailStatusLabels');
const { normalizeDomain, getRegistrableDomain } = require('../utils/domainIdentity');
const { scrubSensitiveContent } = require('../utils/contentScrubber');
const { ensurePlaywrightRuntimeReady } = require('../utils/runtimePreflight');

const OUTPUT_DIR = path.join(__dirname, '../artifacts/newsletters');
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const DEFAULT_B2_BUCKET_NAME = 'urklist';

const PROMO_PATTERNS = [
  /(?:code|coupon|promo|voucher)[:\s]+([A-Z0-9_-]{3,20})/gi,
  /\b([A-Z]{3,}[0-9]{0,4})\b/g
];

const DISCOUNT_PATTERN = /\b(\d{1,2}%\s*(?:off|OFF|discount|DISCOUNT))\b/;

let b2Session = null;
let cachedUrkUserId = null;

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function slugifyText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120);
}

function extractDomainFromEmail(email = '') {
  if (!email.includes('@')) return '';
  return normalizeDomain(email.split('@').pop());
}

function formatBrandNameFromDomain(domain = '') {
  const registrable = getRegistrableDomain(domain) || domain;
  const label = (registrable || '').split('.')[0] || 'Brand';
  return label
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

async function resolveOrCreateAgentBrandForIngest(message) {
  const senderEmail = String(message?.fromEmail || '').trim().toLowerCase();
  const senderDomain = extractDomainFromEmail(senderEmail);
  const registrable = getRegistrableDomain(senderDomain) || senderDomain;
  if (!registrable) return null;

  const websiteCandidates = [`https://${registrable}`, `http://${registrable}`];
  let brand = await Brand.findOne({
    $or: [
      { domain: registrable },
      { websiteUrl: { $in: websiteCandidates } },
      { currentSenderEmail: senderEmail || null },
      { knownSenderEmails: senderEmail || null },
      { knownSenderDomains: registrable }
    ]
  });

  if (brand) return brand;

  const now = new Date();
  const name = formatBrandNameFromDomain(registrable);
  brand = new Brand({
    name,
    domain: registrable,
    websiteUrl: `https://${registrable}`,
    source: 'manual',
    discoveredAt: now,
    onboardingStatus: 'active',
    statusUpdatedAt: now,
    statusHistory: [{ status: 'active', changedAt: now, note: 'Auto-created from ingest fallback' }],
    currentSenderEmail: senderEmail || undefined,
    primarySenderEmail: senderEmail || undefined,
    currentSenderDomain: senderDomain || undefined,
    primarySenderDomain: senderDomain || undefined,
    knownSenderEmails: senderEmail ? [senderEmail] : [],
    knownSenderDomains: [senderDomain, registrable].filter(Boolean),
    firstNewsletterAt: message?.receivedAt || now,
    lastNewsletterAt: message?.receivedAt || now,
    subscriptionEmail: process.env.GMAIL_USER || undefined
  });

  try {
    await brand.save();
    logger.info(`[ingest_newsletters] Auto-created brand ${brand.name} (${brand.domain}) for ${message.gmailMessageId}`);
    return brand;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return Brand.findOne({ domain: registrable });
  }
}

function extractPromoCodes(subject = '', body = '') {
  const text = `${subject || ''}\n${body || ''}`;
  const found = new Set();

  for (const pattern of PROMO_PATTERNS) {
    let match = pattern.exec(text);
    while (match) {
      const code = (match[1] || match[0] || '').trim().toUpperCase();
      if (code.length >= 3 && code.length <= 20 && /[A-Z]/.test(code) && /\d|[A-Z]{4,}/.test(code)) {
        if (!code.includes('HTTP') && !code.includes('HTML')) found.add(code);
      }
      match = pattern.exec(text);
    }
    pattern.lastIndex = 0;
  }

  return Array.from(found).slice(0, 10);
}

function extractDiscountText(subject = '') {
  const match = DISCOUNT_PATTERN.exec(subject || '');
  if (!match) return null;
  return match[1];
}

function readNumberEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function readBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function defaultScreenshotUserAgent() {
  return process.env.NEWSLETTER_SCREENSHOT_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
}

async function screenshotEmailMessage(message, { sharedBrowser, options = {} } = {}) {
  ensureOutputDir();
  const safeId = String(message.gmailMessageId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(OUTPUT_DIR, `${safeId}.png`);

  const html = message.bodyHtml
    ? scrubSensitiveContent(message.bodyHtml)
    : `<html><body><pre style="white-space:pre-wrap;font-family:Arial,sans-serif;">${scrubSensitiveContent(message.bodyText || message.textBody || message.snippet || '')}</pre></body></html>`;

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || undefined;
  const viewportWidth = Number(process.env.NEWSLETTER_SCREENSHOT_VIEWPORT_WIDTH || 600);
  const viewportHeight = Number(process.env.NEWSLETTER_SCREENSHOT_VIEWPORT_HEIGHT || 1200);
  const stabilizeMs = Number.isFinite(Number(options.stabilizeMs))
    ? Number(options.stabilizeMs)
    : readNumberEnv('NEWSLETTER_SCREENSHOT_STABILIZE_MS', 6000);
  const retryStabilizeMs = Number.isFinite(Number(options.retryStabilizeMs))
    ? Number(options.retryStabilizeMs)
    : readNumberEnv('NEWSLETTER_SCREENSHOT_RETRY_STABILIZE_MS', 5000);
  const maxImgWaitMs = Number.isFinite(Number(options.maxImgWaitMs))
    ? Number(options.maxImgWaitMs)
    : readNumberEnv('NEWSLETTER_SCREENSHOT_MAX_IMAGE_WAIT_MS', 12000);
  const maxCaptureHeight = Number.isFinite(Number(options.maxCaptureHeight))
    ? Number(options.maxCaptureHeight)
    : readNumberEnv('NEWSLETTER_SCREENSHOT_MAX_CAPTURE_HEIGHT', 2200);
  const forceWidthRewrite = typeof options.forceWidthRewrite === 'boolean'
    ? options.forceWidthRewrite
    : readBoolEnv('NEWSLETTER_SCREENSHOT_FORCE_WIDTH_REWRITE', false);
  const minImageLoadRatio = Number.isFinite(Number(options.minImageLoadRatio))
    ? Number(options.minImageLoadRatio)
    : Number(process.env.NEWSLETTER_SCREENSHOT_MIN_IMAGE_LOAD_RATIO || 0.35);
  const maxQualityPasses = Math.max(
    1,
    Number.isFinite(Number(options.maxQualityPasses))
      ? Number(options.maxQualityPasses)
      : readNumberEnv('NEWSLETTER_SCREENSHOT_MAX_QUALITY_PASSES', 2)
  );
  const minMeaningfulBottom = Number.isFinite(Number(options.minMeaningfulBottom))
    ? Number(options.minMeaningfulBottom)
    : readNumberEnv('NEWSLETTER_SCREENSHOT_MIN_MEANINGFUL_BOTTOM', 300);
  const strictQualityGate = typeof options.strictQualityGate === 'boolean'
    ? options.strictQualityGate
    : readBoolEnv('NEWSLETTER_SCREENSHOT_STRICT_QUALITY_GATE', true);
  const ownBrowser = !sharedBrowser;
  const browser = sharedBrowser || await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  let context;
  let page;
  try {
    context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent: defaultScreenshotUserAgent(),
      locale: 'en-US'
    });
    page = await context.newPage();
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://mail.google.com/',
      'Upgrade-Insecure-Requests': '1'
    });
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    } catch (err) {
      // Some large/complex newsletter HTML hangs networkidle forever.
      // Fallback to a plain-text render so we still get a deterministic screenshot.
      const fallbackHtml = `<html><body><pre style="white-space:pre-wrap;font-family:Arial,sans-serif;">${scrubSensitiveContent(message.bodyText || message.textBody || message.snippet || message.subject || '(empty email)')}</pre></body></html>`;
      logger.warn(`[screenshot] setContent timeout for ${message.gmailMessageId}; using fallback text render`);
      await page.setContent(fallbackHtml, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    // Improve compatibility with email templates that lazy-load or rely on
    // `data-src` style image attributes.
    await page.evaluate(() => {
      const imgSelectors = ['img[data-src]', 'img[data-original]', 'img[data-lazy-src]'];
      imgSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((img) => {
          const src = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
          if (src && !img.getAttribute('src')) img.setAttribute('src', src);
        });
      });
      document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
        img.setAttribute('loading', 'eager');
      });
    });

    if (forceWidthRewrite) {
      // Optional width rewrite for templates that render as narrow centered strips.
      // Disabled by default because it can break some brand layouts.
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = [
          'html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; width: 100% !important; }',
          'table { width: 100% !important; max-width: 100% !important; }',
          'td { max-width: 100% !important; }',
          'center { width: 100% !important; }',
          'img { max-width: 100% !important; height: auto !important; }',
          '.wrapper, .container, .email-body, .email-container { width: 100% !important; max-width: 100% !important; }'
        ].join('\n');
        document.head.appendChild(style);
        document.querySelectorAll('table[width]').forEach((t) => t.removeAttribute('width'));
        document.querySelectorAll('td[width]').forEach((td) => {
          const w = parseInt(td.getAttribute('width'), 10);
          if (w > 300) td.removeAttribute('width');
        });
      });
    }

    await page.waitForLoadState('networkidle').catch(() => {});

    // Wait for image decode/load best effort.
    await page.evaluate((maxWait) => {
      return Promise.all(
        Array.from(document.querySelectorAll('img')).map((img) => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return Promise.race([
            new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            }),
            new Promise((resolve) => setTimeout(resolve, maxWait))
          ]);
        })
      );
    }, maxImgWaitMs);

    await page.evaluate((maxWait) => {
      const bgElements = [];
      const allElements = document.querySelectorAll('*');
      for (let i = 0; i < allElements.length; i += 1) {
        const style = window.getComputedStyle(allElements[i]);
        const bgImage = style.backgroundImage;
        if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
          const urlMatch = bgImage.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          if (urlMatch) bgElements.push(urlMatch[1]);
        }
      }
      if (bgElements.length === 0) return Promise.resolve();
      return Promise.all(bgElements.map((url) => {
        return Promise.race([
          new Promise((resolve) => {
            const img = new Image();
            img.onload = resolve;
            img.onerror = resolve;
            img.src = url;
          }),
          new Promise((resolve) => setTimeout(resolve, maxWait))
        ]);
      }));
    }, maxImgWaitMs);

    await page.evaluate(() => {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready;
      }
      return Promise.resolve();
    }).catch(() => {});

    let quality = null;
    let imgRatio = 1;
    for (let pass = 1; pass <= maxQualityPasses; pass += 1) {
      // Trigger common lazy-load behaviors that need scroll interaction.
      await page.evaluate(() => {
        const maxY = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        );
        window.scrollTo(0, Math.min(maxY, window.innerHeight * 2));
      }).catch(() => {});
      await page.waitForTimeout(250);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

      const waitMs = pass === 1 ? stabilizeMs : retryStabilizeMs;
      await page.waitForTimeout(waitMs);

      quality = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const loaded = imgs.filter((img) => img.complete && img.naturalWidth > 0).length;
        let maxBottom = 0;
        let textChars = 0;
        let meaningfulNodes = 0;
        const nodes = Array.from(document.querySelectorAll('body *'));
        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          if (!rect || rect.height <= 0 || rect.width <= 0) continue;
          const text = (node.textContent || '').trim();
          const hasText = text.length > 20;
          const hasMedia = node.tagName === 'IMG';
          if (hasText || hasMedia) {
            maxBottom = Math.max(maxBottom, node.offsetTop + rect.height);
            meaningfulNodes += 1;
          }
          if (text.length > 0) {
            textChars += Math.min(text.length, 300);
          }
        }
        const body = document.body;
        const doc = document.documentElement;
        const scrollHeight = Math.max(
          body ? body.scrollHeight : 0,
          doc ? doc.scrollHeight : 0,
          body ? body.offsetHeight : 0,
          doc ? doc.offsetHeight : 0
        );
        return {
          imgTotal: imgs.length,
          imgLoaded: loaded,
          scrollHeight,
          meaningfulBottom: Math.ceil(maxBottom),
          meaningfulNodes,
          textChars
        };
      });

      imgRatio = quality.imgTotal > 0 ? (quality.imgLoaded / quality.imgTotal) : 1;
      const lowImageRatio = quality.imgTotal >= 8 && imgRatio < minImageLoadRatio;
      const weakAboveFold = quality.meaningfulBottom < 260 && quality.scrollHeight > 500;
      if (!lowImageRatio && !weakAboveFold) break;
      if (pass < maxQualityPasses) {
        logger.warn(
          `[screenshot] quality retry ${pass}/${maxQualityPasses} for ${message.gmailMessageId}: loaded=${quality.imgLoaded}/${quality.imgTotal}, meaningfulBottom=${quality.meaningfulBottom}`
        );
      }
    }

    if (quality?.imgTotal >= 8 && imgRatio < minImageLoadRatio) {
      logger.warn(`[screenshot] Low image-load ratio for ${message.gmailMessageId}: loaded=${quality.imgLoaded}/${quality.imgTotal}`);
    }

    const likelyFooterOnly = (quality?.meaningfulBottom || 0) < minMeaningfulBottom && (quality?.scrollHeight || 0) > 700;
    const likelyEmpty = (quality?.meaningfulNodes || 0) <= 4 && (quality?.textChars || 0) < 90 && (quality?.imgLoaded || 0) === 0 && (quality?.scrollHeight || 0) > 600;
    const likelyImageStarved = (quality?.imgTotal || 0) >= 6 && imgRatio < minImageLoadRatio;

    if (strictQualityGate && (likelyFooterOnly || likelyEmpty || likelyImageStarved)) {
      const reason = [
        likelyFooterOnly ? 'footer_only' : null,
        likelyEmpty ? 'empty' : null,
        likelyImageStarved ? 'image_starved' : null
      ].filter(Boolean).join('+');
      throw new Error(
        `screenshot_quality_gate_failed:${reason}:loaded=${quality?.imgLoaded || 0}/${quality?.imgTotal || 0}:meaningfulBottom=${quality?.meaningfulBottom || 0}:textChars=${quality?.textChars || 0}`
      );
    }

    const desiredHeight = Math.min(
      maxCaptureHeight,
      Math.max(
        380,
        Math.min(
          quality.scrollHeight || viewportHeight,
          (quality.meaningfulBottom || viewportHeight) + 24
        )
      )
    );

    await page.screenshot({
      path: filePath,
      clip: {
        x: 0,
        y: 0,
        width: viewportWidth,
        height: desiredHeight
      }
    });
    return filePath;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (ownBrowser) await browser.close().catch(() => {});
  }
}

function canUseB2() {
  return !!(process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY);
}

async function authorizeB2() {
  if (b2Session?.accountAuthToken && b2Session?.apiUrl && b2Session?.bucketId) {
    return b2Session;
  }

  const authBase = process.env.B2_AUTH_BASE_URL || 'https://api.backblazeb2.com';
  const bucketName = process.env.B2_BUCKET_NAME || DEFAULT_B2_BUCKET_NAME;

  const authRes = await axios.get(`${authBase}/b2api/v2/b2_authorize_account`, {
    auth: {
      username: process.env.B2_KEY_ID,
      password: process.env.B2_APPLICATION_KEY
    },
    timeout: 15000
  });

  const { accountId, authorizationToken, apiUrl, downloadUrl } = authRes.data;

  const bucketRes = await axios.post(
    `${apiUrl}/b2api/v2/b2_list_buckets`,
    { accountId, bucketName },
    {
      headers: { Authorization: authorizationToken },
      timeout: 15000
    }
  );

  const bucket = (bucketRes.data?.buckets || []).find((item) => item.bucketName === bucketName);
  if (!bucket?.bucketId) {
    throw new Error(`B2 bucket not found: ${bucketName}`);
  }

  const uploadRes = await axios.post(
    `${apiUrl}/b2api/v2/b2_get_upload_url`,
    { bucketId: bucket.bucketId },
    {
      headers: { Authorization: authorizationToken },
      timeout: 15000
    }
  );

  b2Session = {
    accountId,
    accountAuthToken: authorizationToken,
    apiUrl,
    downloadUrl,
    bucketId: bucket.bucketId,
    bucketName,
    uploadUrl: uploadRes.data.uploadUrl,
    uploadAuthToken: uploadRes.data.authorizationToken
  };

  return b2Session;
}

async function refreshUploadUrl() {
  const session = await authorizeB2();
  const uploadRes = await axios.post(
    `${session.apiUrl}/b2api/v2/b2_get_upload_url`,
    { bucketId: session.bucketId },
    {
      headers: { Authorization: session.accountAuthToken },
      timeout: 15000
    }
  );
  session.uploadUrl = uploadRes.data.uploadUrl;
  session.uploadAuthToken = uploadRes.data.authorizationToken;
  return session;
}

async function uploadScreenshotToB2(filePath, key, maxRetries = 3) {
  const session = await authorizeB2();
  const fileBuffer = fs.readFileSync(filePath);
  const sha1 = crypto.createHash('sha1').update(fileBuffer).digest('hex');
  const encodedName = encodeURIComponent(key).replace(/%2F/g, '/');

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await axios.post(session.uploadUrl, fileBuffer, {
        headers: {
          Authorization: session.uploadAuthToken,
          'X-Bz-File-Name': encodedName,
          'Content-Type': 'image/png',
          'X-Bz-Content-Sha1': sha1
        },
        maxBodyLength: Infinity,
        timeout: 30000
      });
      return `${session.downloadUrl}/file/${session.bucketName}/${encodedName}`;
    } catch (err) {
      const status = err?.response?.status;
      if (status === 401) {
        await refreshUploadUrl();
      }
      if (attempt === maxRetries) throw err;
      const waitMs = 1000 * (2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return null;
}

function buildVersionedScreenshotFileName({ subject = 'newsletter', messageId, suffix = '' }) {
  const safeTitle = slugifyText(subject || 'newsletter') || 'newsletter';
  const safeId = String(messageId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const version = Date.now().toString(36);
  const normalizedSuffix = suffix ? `-${suffix}` : '';
  return `${safeTitle}-${safeId}${normalizedSuffix}-v${version}.png`;
}

async function getOrCreateDefaultCategoryId() {
  const db = mongoose.connection.db;
  const categoryCol = db.collection('Category');

  const existing = await categoryCol.findOne({ name: DEFAULT_CATEGORY_NAME });
  if (existing?._id) return existing._id;

  const now = new Date();
  const result = await categoryCol.insertOne({
    name: DEFAULT_CATEGORY_NAME,
    description: 'Auto-created category for brands discovered via onboarding agent',
    createdAt: now,
    updatedAt: now
  });

  return result.insertedId;
}

function buildSiteUrlCandidates(domain = '') {
  if (!domain) return [];
  const normalized = normalizeDomain(domain);
  const registrable = getRegistrableDomain(normalized) || normalized;
  const candidates = new Set([
    `https://${normalized}`,
    `http://${normalized}`,
    `https://${registrable}`,
    `http://${registrable}`
  ]);
  return Array.from(candidates);
}

async function resolveOrCreateUrkBrand({ message, agentBrand }) {
  const db = mongoose.connection.db;
  const urkBrandCol = db.collection('Brand');
  const senderEmail = String(message.fromEmail || '').toLowerCase().trim();
  const senderDomain = extractDomainFromEmail(senderEmail);
  const registrable = getRegistrableDomain(senderDomain) || senderDomain;
  const siteURL = registrable ? `https://${registrable}` : null;
  const baseSlug = slugifyText((registrable || '').split('.')[0] || agentBrand?.name || 'brand') || 'brand';

  const candidate = await urkBrandCol.findOne({
    $or: [
      senderEmail ? { email: senderEmail } : null,
      siteURL ? { siteURL: { $in: buildSiteUrlCandidates(registrable) } } : null,
      { slug: baseSlug }
    ].filter(Boolean)
  });
  if (candidate?._id) return candidate._id;

  const categoryId = await getOrCreateDefaultCategoryId();
  const brandName = agentBrand?.name || formatBrandNameFromDomain(registrable || senderDomain);
  const now = new Date();

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
    const doc = {
      name: brandName,
      email: senderEmail || `${slug}@${registrable || 'example.com'}`,
      slug,
      category_id: categoryId,
      siteURL: siteURL || undefined,
      createdAt: now,
      updatedAt: now
    };
    try {
      const result = await urkBrandCol.insertOne(doc);
      return result.insertedId;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const existing = await urkBrandCol.findOne({
        $or: [
          senderEmail ? { email: senderEmail } : null,
          siteURL ? { siteURL: { $in: buildSiteUrlCandidates(registrable) } } : null,
          { slug }
        ].filter(Boolean)
      });
      if (existing?._id) return existing._id;
    }
  }

  throw new Error(`Unable to resolve/create urk Brand for sender: ${senderEmail}`);
}

async function upsertUrkListing({ message, agentBrand, screenshotUrl }) {
  const db = mongoose.connection.db;
  const listingCol = db.collection('Listing');
  const urkBrandId = await resolveOrCreateUrkBrand({ message, agentBrand });
  const userId = await resolveUrkUserId(listingCol);

  const title = scrubSensitiveContent(message.subject || '(no subject)');
  const htmlContent = scrubSensitiveContent(message.bodyHtml || '') || null;
  const bodyText = scrubSensitiveContent(message.bodyText || message.textBody || message.snippet || '');
  const nextPromoCodes = extractPromoCodes(title, `${htmlContent || ''}\n${bodyText}`);
  const nextDiscountText = extractDiscountText(title);
  const now = new Date();
  const existing = await listingCol.findOne({ messageId: message.gmailMessageId });

  // Non-destructive merge: keep existing persisted values if new run does not provide them.
  const mergedPromoCodes = Array.from(new Set([...(existing?.promoCodes || []), ...nextPromoCodes])).slice(0, 25);
  const mergedContent = screenshotUrl || existing?.content || '';
  const mergedHtmlContent = htmlContent || existing?.htmlContent || null;
  const mergedDiscountText = nextDiscountText || existing?.discountText || null;

  await listingCol.updateOne(
    { messageId: message.gmailMessageId },
    {
      $set: {
        title,
        slugifyTitle: slugifyText(title) || null,
        brandEmail: message.fromEmail || '',
        receivedAt: message.receivedAt || now,
        messageId: message.gmailMessageId,
        content: mergedContent,
        htmlContent: mergedHtmlContent,
        promoCodes: mergedPromoCodes,
        discountText: mergedDiscountText,
        ingestionSource: 'brand-onboarding-agent',
        pipelineVersion: 'boa-v2',
        sourceEmailMessageId: message.gmailMessageId,
        sourceRfc822MessageId: message.rfc822MessageId || null,
        sourceThreadId: message.threadId || null,
        sourceFromDomain: message.fromDomain || null,
        sourceSenderApexDomain: message.senderApexDomain || null,
        sourceEmailType: message.emailType || 'unknown',
        lastIngestedAt: now,
        brandId: urkBrandId,
        userId,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );
}

async function materializeListingForMessage({ message, brand, withScreenshots = true, forceScreenshotRetake = false, context = 'ingest_newsletters' }) {
  let screenshotPath = null;
  let screenshotUrl = null;

  // Reuse existing URL if already uploaded (unless force retake requested).
  if (!forceScreenshotRetake) {
    const existingPath = String(message.screenshotPath || '');
    if (/^https?:\/\//i.test(existingPath)) {
      screenshotUrl = existingPath;
    }
  }

  // Safety: never persist ephemeral local file paths into Listing.content.
  // If B2 is not configured, skip screenshot generation in automated runs.
  const b2Enabled = canUseB2();
  if (withScreenshots && !screenshotUrl && b2Enabled) {
    const maxAttempts = Math.max(1, readNumberEnv('NEWSLETTER_SCREENSHOT_INGEST_MAX_ATTEMPTS', 3));
    const relaxedFinalAttempt = readBoolEnv('NEWSLETTER_SCREENSHOT_RELAXED_FINAL_ATTEMPT', true);
    for (let attempt = 1; attempt <= maxAttempts && !screenshotUrl; attempt += 1) {
      try {
        screenshotPath = await screenshotEmailMessage(message, {
          options: {
            // Keep strict quality for early attempts, then allow a final relaxed pass
            // so a few image-starved templates don't stay permanently stuck.
            strictQualityGate: !(relaxedFinalAttempt && attempt === maxAttempts),
            // Give retries more time and optional width rewrite fallback on final attempt.
            stabilizeMs: attempt === 1 ? undefined : 9000,
            retryStabilizeMs: attempt === 1 ? undefined : 7000,
            maxQualityPasses: attempt === 1 ? undefined : 3,
            forceWidthRewrite: attempt >= 3 ? true : undefined
          }
        });
        if (screenshotPath) {
          const fileName = buildVersionedScreenshotFileName({
            subject: message.subject || 'newsletter',
            messageId: message.gmailMessageId
          });
          screenshotUrl = await uploadScreenshotToB2(screenshotPath, fileName);
          if (screenshotUrl) {
            await markEmailActivity({
              gmailMessageId: message.gmailMessageId,
              activity: 'screenshot_captured',
              emailMessage: message
            });
          }
        }
      } catch (screenshotErr) {
        logger.warn(`[${context}] screenshot attempt ${attempt}/${maxAttempts} failed for ${message.gmailMessageId}: ${screenshotErr.message}`);
        if (attempt >= maxAttempts) {
          logger.warn(`[${context}] screenshot/upload skipped for ${message.gmailMessageId}: ${screenshotErr.message}`);
        }
      } finally {
        if (screenshotPath && fs.existsSync(screenshotPath)) {
          fs.unlinkSync(screenshotPath);
          screenshotPath = null;
        }
      }
    }
  } else if (withScreenshots && !b2Enabled) {
    logger.warn(`[${context}] B2 not configured; skipping screenshot generation for ${message.gmailMessageId}`);
  }

  await upsertUrkListing({ message, agentBrand: brand, screenshotUrl });

  return {
    screenshotUrl: screenshotUrl || null
  };
}

async function resolveUrkUserId(listingCol) {
  if (cachedUrkUserId && mongoose.Types.ObjectId.isValid(cachedUrkUserId)) {
    return new mongoose.Types.ObjectId(cachedUrkUserId);
  }

  const envUserId = String(process.env.URKLIST_USER_ID || '').trim();
  if (mongoose.Types.ObjectId.isValid(envUserId)) {
    cachedUrkUserId = envUserId;
    return new mongoose.Types.ObjectId(envUserId);
  }

  const fallbackDoc = await listingCol.findOne(
    { userId: { $exists: true, $ne: null } },
    {
      projection: { userId: 1 },
      sort: { updatedAt: -1, createdAt: -1 }
    }
  );
  const fallbackUserId = String(fallbackDoc?.userId || '').trim();
  if (mongoose.Types.ObjectId.isValid(fallbackUserId)) {
    cachedUrkUserId = fallbackUserId;
    logger.warn(`[ingest_newsletters] URKLIST_USER_ID missing/invalid; using fallback userId from existing Listing records: ${fallbackUserId}`);
    return new mongoose.Types.ObjectId(fallbackUserId);
  }

  throw new Error('URKLIST_USER_ID missing or invalid and no fallback userId found in Listing collection');
}

async function markMessageIngestResult({ message, success, error = null, version = 'v2' }) {
  message.processedBy = message.processedBy || {};
  message.processedBy.ingestion_runner = {
    done: success,
    at: new Date(),
    version,
    attempts: (message.processedBy?.ingestion_runner?.attempts || 0) + 1,
    status: success ? 'done' : 'error',
    lastProcessedAt: new Date(),
    error
  };
  if (success) {
    message.ingestedAt = new Date();
    message.state = 'finalized';
    message.needsReview = false;
    message.processingTrace = {
      ...(message.processingTrace || {}),
      listing_upsert: {
        at: new Date(),
        status: 'done'
      },
      ingest: {
        at: new Date(),
        status: 'done'
      }
    };
  } else {
    message.state = 'error';
    message.needsReview = true;
    message.processingTrace = {
      ...(message.processingTrace || {}),
      ingest: {
        at: new Date(),
        status: 'error',
        error
      }
    };
  }
}

async function markMessageIngestRetryPending({ message, reason = 'screenshot_missing', version = 'v2' }) {
  message.processedBy = message.processedBy || {};
  message.processedBy.ingestion_runner = {
    done: false,
    at: new Date(),
    version,
    attempts: (message.processedBy?.ingestion_runner?.attempts || 0) + 1,
    status: 'skipped',
    lastProcessedAt: new Date(),
    error: reason
  };
  if (!['ingested', 'finalized'].includes(String(message.state || ''))) {
    message.state = 'brand_resolved';
  }
  message.needsReview = false;
  message.processingTrace = {
    ...(message.processingTrace || {}),
    ingest: {
      at: new Date(),
      status: 'retry_pending',
      error: reason
    }
  };
}

async function ingestPendingNewsletters({ limit = 50 } = {}) {
  const requireScreenshot = String(process.env.INGEST_REQUIRE_SCREENSHOT ?? 'true').toLowerCase() !== 'false';
  const preflightAutoInstall = String(process.env.INGEST_PREFLIGHT_AUTO_INSTALL ?? 'false').toLowerCase() === 'true';
  if (requireScreenshot) {
    if (!canUseB2()) {
      throw new Error('screenshot_required_but_b2_not_configured');
    }
    const runtime = await ensurePlaywrightRuntimeReady({ autoInstall: preflightAutoInstall });
    if (!runtime?.ready) {
      throw new Error(`ingest_runtime_preflight_failed:${runtime?.reason || 'unknown'}`);
    }
  }

  const candidates = await EmailMessage.find({
    emailType: { $in: ['newsletter', 'welcome'] },
    $or: [
      { ingestedAt: { $exists: false } },
      { ingestedAt: null }
    ],
    state: { $nin: ['ingested', 'finalized'] },
    'processedBy.ingestion_runner.done': { $ne: true }
  }).sort({ receivedAt: -1 }).limit(limit);

  const stats = {
    scanned: candidates.length,
    ingested: 0,
    failed: 0,
    skipped: 0,
    screenshotMissing: 0,
    requireScreenshot
  };

  for (const message of candidates) {
    message.processedBy = message.processedBy || {};
    let brand = null;
    if (message.brandId) {
      brand = await Brand.findById(message.brandId);
    }
    if (!brand) {
      brand = await resolveOrCreateAgentBrandForIngest(message);
    }
    if (!brand) {
      message.processedBy.ingestion_runner = {
        done: false,
        at: new Date(),
        version: 'v2',
        attempts: (message.processedBy?.ingestion_runner?.attempts || 0) + 1,
        status: 'skipped',
        lastProcessedAt: new Date(),
        error: 'Missing brandId'
      };
      message.needsReview = true;
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'ingestion_skipped',
        emailMessage: message
      });
      stats.skipped += 1;
      continue;
    }
    if (!message.brandId || String(message.brandId) !== String(brand._id)) {
      message.brandId = brand._id;
      if (String(message.state || '') === 'brand_unresolved') {
        message.state = 'brand_resolved';
      }
    }

    try {
      const materialized = await materializeListingForMessage({
        message,
        brand,
        withScreenshots: true,
        context: 'ingest_newsletters'
      });
      if (requireScreenshot && !materialized?.screenshotUrl) {
        await markMessageIngestRetryPending({ message, reason: 'screenshot_missing', version: 'v2' });
        await message.save();
        await markEmailActivity({
          gmailMessageId: message.gmailMessageId,
          activity: 'ingestion_skipped',
          emailMessage: message
        });
        stats.skipped += 1;
        stats.screenshotMissing += 1;
        continue;
      }
      message.screenshotPath = materialized.screenshotUrl;
      await markMessageIngestResult({ message, success: true, version: 'v2' });
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'ingested',
        emailMessage: message
      });

      if (message.emailType === 'newsletter') {
        if (!brand.firstNewsletterAt) brand.firstNewsletterAt = message.receivedAt || new Date();
        brand.lastNewsletterAt = message.receivedAt || new Date();
      }
      await brand.save();

      stats.ingested += 1;
    } catch (err) {
      logger.warn(`[ingest_newsletters] ${message.gmailMessageId}: ${err.message}`);
      await markMessageIngestResult({ message, success: false, error: err.message, version: 'v2' });
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'error',
        emailMessage: message
      });
      stats.failed += 1;
    }
  }

  logger.info(`[ingest_newsletters] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

async function retryMissingScreenshotsForIngested({ limit = 50 } = {}) {
  const safeLimit = Math.max(1, Number(limit) || 50);
  if (!canUseB2()) {
    throw new Error('retry_missing_screenshots_requires_b2');
  }
  const runtime = await ensurePlaywrightRuntimeReady({ autoInstall: false });
  if (!runtime?.ready) {
    throw new Error(`retry_missing_screenshots_runtime_preflight_failed:${runtime?.reason || 'unknown'}`);
  }

  const candidates = await EmailMessage.find({
    emailType: { $in: ['newsletter', 'welcome'] },
    $or: [
      { ingestedAt: { $exists: true, $ne: null } },
      { state: { $in: ['ingested', 'finalized'] } },
      { 'processedBy.ingestion_runner.done': true }
    ],
    $and: [
      {
        $or: [
          { screenshotPath: { $exists: false } },
          { screenshotPath: null },
          { screenshotPath: '' },
          { screenshotPath: { $not: /^https?:\/\//i } }
        ]
      }
    ],
    brandId: { $exists: true, $ne: null }
  })
    .sort({ receivedAt: -1 })
    .limit(safeLimit);

  const stats = {
    scanned: candidates.length,
    repaired: 0,
    stillMissing: 0,
    failed: 0
  };

  for (const message of candidates) {
    try {
      const brand = await Brand.findById(message.brandId);
      if (!brand) {
        stats.failed += 1;
        continue;
      }
      const materialized = await materializeListingForMessage({
        message,
        brand,
        withScreenshots: true,
        forceScreenshotRetake: true,
        context: 'retry_missing_screenshots'
      });
      if (!materialized?.screenshotUrl) {
        await markMessageIngestRetryPending({ message, reason: 'screenshot_missing', version: 'v2' });
        await message.save();
        await markEmailActivity({
          gmailMessageId: message.gmailMessageId,
          activity: 'ingestion_skipped',
          emailMessage: message
        });
        stats.stillMissing += 1;
        continue;
      }
      message.screenshotPath = materialized.screenshotUrl;
      await markMessageIngestResult({ message, success: true, version: 'v2' });
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'screenshot_captured',
        emailMessage: message
      });
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'ingested',
        emailMessage: message
      });
      stats.repaired += 1;
    } catch (err) {
      stats.failed += 1;
      logger.warn(`[retry_missing_screenshots] ${message.gmailMessageId}: ${err.message}`);
    }
  }

  logger.info(`[retry_missing_screenshots] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

async function backfillListingsFromEmailMessages({
  limit = 500,
  withScreenshots = false,
  forceUpdate = false,
  missingScreenshotOnly = false,
  forceScreenshotRetake = false
} = {}) {
  const db = mongoose.connection.db;
  const listingCol = db.collection('Listing');

  const candidates = await EmailMessage.find({
    emailType: { $in: ['newsletter', 'welcome'] },
    brandId: { $exists: true, $ne: null },
    gmailMessageId: { $exists: true, $ne: null }
  }).sort({ receivedAt: 1 }).limit(limit);

  const stats = {
    scanned: candidates.length,
    backfilled: 0,
    screenshotUploaded: 0,
    screenshotMissing: 0,
    alreadyPresent: 0,
    skippedHasScreenshot: 0,
    skippedNoBrand: 0,
    failed: 0
  };

  for (const message of candidates) {
    try {
      const existing = await listingCol.findOne(
        { messageId: message.gmailMessageId },
        { projection: { _id: 1, content: 1 } }
      );

      if (missingScreenshotOnly) {
        const hasListingScreenshot = /^https?:\/\//i.test(String(existing?.content || ''));
        // In missing-screenshot mode, only skip when Listing already has a screenshot URL.
        // If message has screenshotPath URL but Listing.content is empty, we should still
        // materialize to copy that URL onto the listing row.
        if (hasListingScreenshot) {
          stats.skippedHasScreenshot += 1;
          continue;
        }
      }

      const allowUpdatingExistingForMissingScreenshot = missingScreenshotOnly && existing;
      if (existing && !forceUpdate && !allowUpdatingExistingForMissingScreenshot) {
        stats.alreadyPresent += 1;
        continue;
      }

      const brand = await Brand.findById(message.brandId);
      if (!brand) {
        stats.skippedNoBrand += 1;
        continue;
      }

      const materialized = await materializeListingForMessage({
        message,
        brand,
        withScreenshots,
        forceScreenshotRetake,
        context: 'backfill_listings'
      });
      if (materialized?.screenshotUrl) stats.screenshotUploaded += 1;
      else if (withScreenshots) stats.screenshotMissing += 1;
      message.screenshotPath = materialized.screenshotUrl || message.screenshotPath || null;
      await markMessageIngestResult({ message, success: true, version: 'v2' });
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'ingested',
        emailMessage: message
      });

      if (message.emailType === 'newsletter') {
        if (!brand.firstNewsletterAt) brand.firstNewsletterAt = message.receivedAt || new Date();
        brand.lastNewsletterAt = message.receivedAt || new Date();
        await brand.save();
      }

      stats.backfilled += 1;
    } catch (err) {
      logger.warn(`[backfill_listings] ${message.gmailMessageId}: ${err.message}`);
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'error',
        emailMessage: message
      });
      stats.failed += 1;
    }
  }

  logger.info(`[backfill_listings] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

/**
 * Re-take screenshots for existing Listing records using correct 600px viewport.
 * Works by iterating directly over the Listing collection (not EmailMessage),
 * finding the HTML content either from the Listing.htmlContent field or from
 * the linked EmailMessage.bodyHtml, then re-rendering and uploading to B2.
 */
async function retakeListingScreenshots({
  limit = 100,
  dryRun = false,
  skipAlreadyRetaken = true,
  untilExhausted = false,
  batchSize = null,
  maxBatches = 250
} = {}) {
  const db = mongoose.connection.db;
  const listingCol = db.collection('Listing');

  // Find listings that have a screenshot URL in content
  // AND have either htmlContent on the listing or a linked messageId
  const query = {
    content: { $regex: '^https?://', $options: 'i' }
  };

  if (skipAlreadyRetaken) {
    query.screenshotRetakenAt = { $exists: false };
  }

  const stats = {
    scanned: 0,
    retaken: 0,
    skippedNoHtml: 0,
    skippedB2Disabled: 0,
    failed: 0,
    batches: 0
  };

  const b2Enabled = canUseB2();
  if (!b2Enabled) {
    logger.warn('[retake_screenshots] B2 not configured; aborting.');
    stats.skippedB2Disabled = stats.scanned;
    return stats;
  }

  // Launch a single shared browser for all retakes
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || undefined;
  let sharedBrowser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  logger.info('[retake_screenshots] Shared browser launched successfully');

  const normalizedBatchSize = Math.max(1, Number(batchSize || limit) || 100);
  const normalizedMaxBatches = Math.max(1, Number(maxBatches) || 250);

  try {
  for (let batch = 0; batch < normalizedMaxBatches; batch += 1) {
    const effectiveLimit = untilExhausted ? normalizedBatchSize : Math.max(1, Number(limit) || 100);
    const listings = await listingCol.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(effectiveLimit)
      .toArray();
    if (!listings.length) {
      break;
    }
    stats.batches += 1;
    stats.scanned += listings.length;

  for (const listing of listings) {
    try {
      // Get HTML: prefer listing.htmlContent, fallback to linked EmailMessage.bodyHtml
      let html = listing.htmlContent || null;

      if (!html && listing.messageId) {
        const email = await EmailMessage.findOne({ gmailMessageId: listing.messageId });
        html = email?.bodyHtml || null;
      }

      if (!html) {
        stats.skippedNoHtml += 1;
        continue;
      }

      if (dryRun) {
        stats.retaken += 1;
        continue;
      }

      // Build a minimal message object for screenshotEmailMessage
      const pseudoMessage = {
        bodyHtml: html,
        gmailMessageId: listing.messageId || String(listing._id)
      };

      const maxAttempts = Math.max(1, readNumberEnv('NEWSLETTER_SCREENSHOT_RETAKE_MAX_ATTEMPTS', 3));
      let screenshotUrl = null;
      let screenshotPath = null;
      for (let attempt = 1; attempt <= maxAttempts && !screenshotUrl; attempt += 1) {
        try {
          screenshotPath = await screenshotEmailMessage(pseudoMessage, {
            sharedBrowser,
            options: {
              strictQualityGate: true,
              stabilizeMs: attempt === 1 ? undefined : 9000,
              retryStabilizeMs: attempt === 1 ? undefined : 7000,
              maxQualityPasses: attempt === 1 ? undefined : 3,
              forceWidthRewrite: attempt >= 3 ? true : undefined
            }
          });
          if (!screenshotPath) continue;
          const fileName = buildVersionedScreenshotFileName({
            subject: listing.title || 'newsletter',
            messageId: pseudoMessage.gmailMessageId,
            suffix: 'retake'
          });
          screenshotUrl = await uploadScreenshotToB2(screenshotPath, fileName);
        } catch (attemptErr) {
          logger.warn('[retake_screenshots] attempt ' + attempt + '/' + maxAttempts + ' failed for ' + (listing._id) + ': ' + attemptErr.message);
        } finally {
          if (screenshotPath && fs.existsSync(screenshotPath)) {
            fs.unlinkSync(screenshotPath);
          }
          screenshotPath = null;
        }
      }

      if (!screenshotUrl) {
        stats.failed += 1;
        continue;
      }

      // Update Listing.content with new screenshot URL
      await listingCol.updateOne(
        { _id: listing._id },
        { $set: { content: screenshotUrl, screenshotRetakenAt: new Date() } }
      );

      // Also update linked EmailMessage if it exists
      if (listing.messageId) {
        await EmailMessage.updateOne(
          { gmailMessageId: listing.messageId },
          { $set: { screenshotPath: screenshotUrl } }
        );
        await markEmailActivity({
          gmailMessageId: listing.messageId,
          activity: 'screenshot_captured'
        });
      }

      stats.retaken += 1;
      if (stats.retaken % 10 === 0) {
        logger.info('[retake_screenshots] Progress: ' + JSON.stringify(stats));
        // Recycle browser every 10 successful screenshots to prevent memory buildup
        try {
          await sharedBrowser.close().catch(() => {});
          sharedBrowser = await chromium.launch({
            headless: true,
            executablePath,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
          });
          logger.info('[retake_screenshots] Browser recycled after ' + stats.retaken + ' screenshots');
        } catch (recycleErr) {
          logger.warn('[retake_screenshots] Browser recycle failed: ' + recycleErr.message);
        }
      }
    } catch (err) {
      logger.warn('[retake_screenshots] ' + (listing._id) + ': ' + err.message);
      stats.failed += 1;
    }
  }
    if (!untilExhausted) break;
  }

  } finally {
    await sharedBrowser.close().catch(() => {});
    logger.info('[retake_screenshots] Shared browser closed');
  }

  logger.info('[retake_screenshots] Completed: ' + JSON.stringify(stats));
  return stats;
}


module.exports = {
  ingestPendingNewsletters,
  backfillListingsFromEmailMessages,
  retakeListingScreenshots,
  retryMissingScreenshotsForIngested
};
