/**
 * Newsletter Signup Service
 * Uses Playwright to find and fill newsletter subscription forms on brand websites.
 * Handles all common form patterns, ESP implementations, and edge cases.
 */

const { chromium } = require('playwright');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { generateProfile, matchFieldToProfile } = require('../utils/humanizer');
const { detectFromHtml, extractKlaviyoCompanyId } = require('../utils/espDetector');
const { classifySignupFailure } = require('../utils/signupFailure');
const { ensurePlaywrightRuntimeReady } = require('../utils/runtimePreflight');
const logger = require('../utils/logger');
const axios = require('axios');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EMAIL = process.env.GMAIL_USER || 'newsletter@example.com';

// Hard cap per brand: 3 minutes
const SIGNUP_TIMEOUT_MS = 3 * 60 * 1000;
const SIGNUP_FAILURE_ARTIFACT_DIR = path.join(__dirname, '../artifacts/signup-failures');

// -- Selector pools for finding newsletter forms ----------------
const FORM_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[placeholder*="email" i]',
  'input[id*="email" i]',
  'input[aria-label*="email" i]',
  'input[class*="email" i]',
  'form input[type="text"]:first-of-type',
  '#mc-embedded-subscribe-form input[type="email"]',
  '.klaviyo-form input[type="email"]',
  '[data-form-element="email"] input',
];

const SUBMIT_SELECTORS = [
  'input[type="submit"]',
  'button[type="submit"]',
  'button:has-text("Subscribe")',
  'button:has-text("Sign up")',
  'button:has-text("Sign Up")',
  'button:has-text("Join")',
  'button:has-text("Get")',
  'button:has-text("Submit")',
  '[data-form-element="submit"]',
  '.klaviyo-form button',
  '#mc-embedded-subscribe',
  'button[class*="subscribe" i]',
  'button[class*="signup" i]',
  'button[class*="newsletter" i]',
  'input[value*="Subscribe" i]',
  'input[value*="Sign up" i]',
];

const SIGNUP_PAGE_PATTERNS = [
  '/newsletter',
  '/subscribe',
  '/email-signup',
  '/join',
  '/signup',
  '/sign-up',
  '/newsletter-signup',
  '/stay-connected'
];

function getBaseOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isSameSiteUrl(url, baseOrigin) {
  try {
    return new URL(url).origin === baseOrigin;
  } catch {
    return false;
  }
}

function hasCaptchaFailure(attemptTrace = []) {
  return (attemptTrace || []).some((attempt) => String(attempt?.reason || '').toLowerCase().includes('captcha'));
}

function findAttemptByReason(attemptTrace = [], reason) {
  return (attemptTrace || []).find((attempt) => String(attempt?.reason || '').toLowerCase() === String(reason || '').toLowerCase());
}

function isPotentialCaptchaState(state = {}) {
  if (!state || typeof state !== 'object') return false;
  const hasMarker = !!(state.hasHcaptchaContainer || state.hasHCaptchaInput || state.hasRecaptchaInput || state.hasCaptchaIframe || state.hcaptchaBound || state.recaptchaBound);
  const tokenMissing = Number(state.hCaptchaValueLen || 0) === 0 && Number(state.recaptchaValueLen || 0) === 0;
  return hasMarker && tokenMissing;
}

async function detectSiteBlocker(page) {
  try {
    const [titleRaw, bodyRaw] = await Promise.all([
      page.title().catch(() => ''),
      page.textContent('body').catch(() => '')
    ]);
    const title = String(titleRaw || '').toLowerCase();
    const body = String(bodyRaw || '').toLowerCase();
    const snippet = body.slice(0, 400);

    if (
      title.includes('just a moment') ||
      body.includes('enable javascript and cookies to continue') ||
      body.includes('cf_chl') ||
      body.includes('cdn-cgi/challenge-platform')
    ) {
      return {
        reason: 'cloudflare_challenge_page',
        message: 'Cloudflare challenge page blocked automated access',
        diagnostic: { title: titleRaw || '', url: page.url(), snippet }
      };
    }

    if (
      title.includes('hang tight') ||
      body.includes('routing to checkout') ||
      body.includes('sit tight') ||
      body.includes('waitroomform') ||
      body.includes('automatically refresh and bring you into the website')
    ) {
      return {
        reason: 'site_waitroom_page',
        message: 'Site waitroom page prevented homepage/form access',
        diagnostic: { title: titleRaw || '', url: page.url(), snippet }
      };
    }

    return null;
  } catch {
    return null;
  }
}

// -- Main Signup Function (with hard 3-min timeout) ------------
/**
 * Attempt to subscribe to a brand's newsletter using Playwright.
 * Wraps core logic with a hard 3-minute timeout so it can never hang indefinitely.
 * @param {string} websiteUrl
 * @param {string} brandName
 * @returns {Object} result: { success, formUrl, espProvider, strategy, error, failureCategory, failureCode, attemptTrace, failureScreenshotPath }
 */
async function signUpForNewsletter(websiteUrl, brandName) {
  const runtime = await ensurePlaywrightRuntimeReady({ autoInstall: true });
  if (!runtime.ready) {
    const reason = runtime.reason || 'Playwright runtime preflight failed';
    const classified = classifySignupFailure(reason);
    logger.warn(`[EMAIL] Runtime preflight failed for ${brandName}: ${reason}`);
    return {
      success: false,
      formUrl: websiteUrl,
      espProvider: 'unknown',
      strategy: null,
      error: reason,
      failureCategory: classified.category,
      failureCode: classified.code,
      attemptTrace: [{ strategy: 'runtime_preflight', success: false, durationMs: 0, reason }],
      failureScreenshotPath: null
    };
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Hard timeout: signup for ${brandName} exceeded 3 minutes`)),
      SIGNUP_TIMEOUT_MS
    )
  );

  try {
    return await Promise.race([_signUpCore(websiteUrl, brandName), timeoutPromise]);
  } catch (err) {
    logger.warn(`[EMAIL] Signup aborted for ${brandName}: ${err.message}`);
    const fallback = await tryHttpSignupFallback(websiteUrl, brandName);
    if (fallback.success) return fallback;
    const classified = classifySignupFailure(err.message || '', null);
    return {
      success: false,
      formUrl: null,
      espProvider: 'unknown',
      strategy: null,
      error: err.message,
      failureCategory: classified.category,
      failureCode: classified.code,
      attemptTrace: [{
        strategy: 'hard_timeout',
        success: false,
        durationMs: SIGNUP_TIMEOUT_MS,
        reason: err.message
      }, {
        strategy: 'http_form_fallback',
        success: false,
        durationMs: 0,
        reason: fallback.error || null
      }],
      failureScreenshotPath: null
    };
  }
}

// -- Core signup logic -----------------------------------------
async function _signUpCore(websiteUrl, brandName) {
  const profile = generateProfile();
  const result = {
    success: false,
    formUrl: null,
    espProvider: 'unknown',
    strategy: null,
    error: null,
    failureCategory: null,
    failureCode: null,
    attemptTrace: [],
    failureScreenshotPath: null
  };
  let browser = null;
  let page = null;

  const recordAttempt = (strategy, res, startedAt) => {
    const durationMs = Math.max(0, Date.now() - startedAt);
    result.attemptTrace.push({
      strategy,
      success: !!(res && res.success),
      durationMs,
      reason: (res && res.reason) || null,
      diagnostic: (res && res.diagnostic) || null
    });
  };

  logger.info(`\n[EMAIL] Signing up for: ${brandName} (${websiteUrl})`);

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--lang=en-US',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    await context.route(/google-analytics|googletagmanager|facebook\.net|hotjar|intercom/, r => r.abort());

    page = await context.newPage();
    page.setDefaultTimeout(20000);

    // -- Strategy 1: dedicated signup/newsletter page ----------
    logger.info(`[EMAIL] ${brandName}: trying Strategy 1 (dedicated signup page)`);
    let startedAt = Date.now();
    const signupPageResult = await tryDedicatedSignupPage(page, websiteUrl, profile, brandName);
    recordAttempt('dedicated_page', signupPageResult, startedAt);
    if (signupPageResult.success) {
      result.success = true;
      result.formUrl = signupPageResult.formUrl;
      result.strategy = 'dedicated_page';
      result.espProvider = signupPageResult.espProvider || 'unknown';
      return result;
    }

    // -- Strategy 2: footer form on homepage -------------------
    logger.info(`[EMAIL] ${brandName}: trying Strategy 2 (footer form)`);
    startedAt = Date.now();
    const footerResult = await tryFooterForm(page, websiteUrl, profile, brandName);
    recordAttempt('footer_form', footerResult, startedAt);
    if (footerResult.success) {
      result.success = true;
      result.formUrl = footerResult.formUrl;
      result.strategy = 'footer_form';
      result.espProvider = footerResult.espProvider || 'unknown';
      return result;
    }

    // -- Strategy 2b: contextual form anywhere on homepage ------
    logger.info(`[EMAIL] ${brandName}: trying Strategy 2b (contextual email form)`);
    startedAt = Date.now();
    const contextualResult = await tryContextualForm(page, websiteUrl, profile, brandName);
    recordAttempt('contextual_form', contextualResult, startedAt);
    if (contextualResult.success) {
      result.success = true;
      result.formUrl = contextualResult.formUrl;
      result.strategy = 'contextual_form';
      result.espProvider = contextualResult.espProvider || 'unknown';
      return result;
    }

    // -- Strategy 2c: open newsletter links and fill forms -------
    logger.info(`[EMAIL] ${brandName}: trying Strategy 2c (newsletter link pages)`);
    startedAt = Date.now();
    const linkPageResult = await tryNewsletterLinkPages(page, websiteUrl, profile, brandName);
    recordAttempt('newsletter_link_pages', linkPageResult, startedAt);
    if (linkPageResult.success) {
      result.success = true;
      result.formUrl = linkPageResult.formUrl;
      result.strategy = 'newsletter_link_pages';
      result.espProvider = linkPageResult.espProvider || 'unknown';
      return result;
    }

    // -- Strategy 3: trigger and fill email popup --------------
    logger.info(`[EMAIL] ${brandName}: trying Strategy 3 (popup trigger)`);
    startedAt = Date.now();
    const popupResult = await tryPopupForm(page, websiteUrl, profile, brandName);
    recordAttempt('popup', popupResult, startedAt);
    if (popupResult.success) {
      result.success = true;
      result.formUrl = popupResult.formUrl;
      result.strategy = 'popup';
      result.espProvider = popupResult.espProvider || 'unknown';
      return result;
    }

    // -- Strategy 4: Klaviyo direct API -----------------------
    logger.info(`[EMAIL] ${brandName}: trying Strategy 4 (Klaviyo API)`);
    const pageSource = await page.content().catch(() => '');
    const espDetected = detectFromHtml(pageSource);
    result.espProvider = espDetected;

    if (espDetected === 'klaviyo') {
      const companyId = extractKlaviyoCompanyId(pageSource);
      if (companyId) {
        startedAt = Date.now();
        const klaviyoResult = await tryKlaviyoApi(companyId, profile.email, brandName);
        recordAttempt('esp_api_klaviyo', klaviyoResult, startedAt);
        if (klaviyoResult.success) {
          result.success = true;
          result.strategy = 'esp_api_klaviyo';
          result.formUrl = websiteUrl;
          return result;
        }
      }
    }

    // -- Strategy 5: Mailchimp embedded form ------------------
    logger.info(`[EMAIL] ${brandName}: trying Strategy 5 (Mailchimp form)`);
    if (espDetected === 'mailchimp') {
      startedAt = Date.now();
      const mailchimpResult = await tryMailchimpForm(page, profile);
      recordAttempt('mailchimp_form', mailchimpResult, startedAt);
      if (mailchimpResult.success) {
        result.success = true;
        result.strategy = 'mailchimp_form';
        result.formUrl = page.url();
        return result;
      }
    }

    const cloudflareBlock = findAttemptByReason(result.attemptTrace, 'cloudflare_challenge_page');
    const waitroomBlock = findAttemptByReason(result.attemptTrace, 'site_waitroom_page');

    if (cloudflareBlock) {
      logger.info(`[EMAIL] ${brandName}: Cloudflare challenge blocked automated access`);
      result.error = 'Cloudflare challenge page blocked automated access';
    } else if (waitroomBlock) {
      logger.info(`[EMAIL] ${brandName}: site waitroom page blocked signup form access`);
      result.error = 'Site waitroom page prevented homepage/form access';
    } else if (hasCaptchaFailure(result.attemptTrace)) {
      logger.info(`[EMAIL] ${brandName}: all strategies exhausted, captcha challenge blocked automation`);
      result.error = 'CAPTCHA challenge blocked automated submission';
    } else {
      logger.info(`[EMAIL] ${brandName}: all strategies exhausted, no form found`);
      result.error = 'No signup form found after all strategies exhausted';
    }
    const classified = classifySignupFailure(result.error, result.strategy);
    result.failureCategory = classified.category;
    result.failureCode = classified.code;

  } catch (err) {
    if (err.message.includes('captcha') || err.message.includes('CAPTCHA')) {
      result.error = 'CAPTCHA detected cannot automate';
    } else if (err.message.includes('Timeout') || err.message.includes('timeout')) {
      result.error = 'Page timeout site too slow or blocking automation';
    } else {
      result.error = err.message;
    }
    const classified = classifySignupFailure(result.error, result.strategy);
    result.failureCategory = classified.category;
    result.failureCode = classified.code;
    logger.warn(`Signup error for ${brandName}: ${result.error}`);

    // Browser launch/system-lib issues: fallback to lightweight HTTP form submit.
    if (/browsertype\.launch|shared libraries|libnspr|executable doesn't exist/i.test(result.error || '')) {
      const httpFallback = await tryHttpSignupFallback(websiteUrl, brandName);
      result.attemptTrace.push({
        strategy: 'http_form_fallback',
        success: !!httpFallback.success,
        durationMs: 0,
        reason: httpFallback.error || null
      });
      if (httpFallback.success) {
        return httpFallback;
      }
    }
  } finally {
    if (!result.success && page) {
      try {
        fs.mkdirSync(SIGNUP_FAILURE_ARTIFACT_DIR, { recursive: true });
        const safeBrand = String(brandName || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const fileName = `${safeBrand || 'brand'}-${Date.now()}.png`;
        const filePath = path.join(SIGNUP_FAILURE_ARTIFACT_DIR, fileName);
        await page.screenshot({ path: filePath, fullPage: true, timeout: 10000 });
        result.failureScreenshotPath = filePath;
      } catch (shotErr) {
        logger.debug(`Failure screenshot capture skipped for ${brandName}: ${shotErr.message}`);
      }
    }
    if (browser) await browser.close().catch(() => {});
  }

  return result;
}

async function tryHttpSignupFallback(websiteUrl, brandName) {
  const profile = generateProfile();
  const candidateUrls = [websiteUrl, ...SIGNUP_PAGE_PATTERNS.map((path) => websiteUrl.replace(/\/$/, '') + path)];
  const seen = new Set();

  for (const url of candidateUrls) {
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const page = await axios.get(url, { timeout: 12000, maxRedirects: 5 });
      const html = String(page.data || '');
      const $ = cheerio.load(html);
      const esp = detectFromHtml(html) || 'unknown';

      if (esp === 'klaviyo') {
        const companyId = extractKlaviyoCompanyId(html);
        if (companyId) {
          const klaviyo = await tryKlaviyoApi(companyId, EMAIL, brandName);
          if (klaviyo.success) {
            return {
              success: true,
              formUrl: url,
              espProvider: 'klaviyo',
              strategy: 'esp_api_klaviyo_http_fallback',
              error: null
            };
          }
        }
      }

      const forms = $('form').toArray();
      for (const form of forms) {
        const formEl = $(form);
        const emailInput = formEl.find('input[type="email"], input[name*="email" i], input[id*="email" i]').first();
        if (!emailInput.length) continue;

        const actionRaw = formEl.attr('action') || url;
        const method = String(formEl.attr('method') || 'post').toLowerCase();
        const actionUrl = new URL(actionRaw, url).toString();
        const payload = {};

        formEl.find('input').each((_, input) => {
          const inputEl = $(input);
          const name = inputEl.attr('name');
          if (!name) return;
          payload[name] = inputEl.attr('value') || '';
        });

        const emailName = emailInput.attr('name') || 'email';
        payload[emailName] = EMAIL;
        if ('first_name' in payload || 'firstname' in payload || 'fname' in payload) {
          payload.first_name = profile.firstName;
          payload.firstname = profile.firstName;
          payload.fname = profile.firstName;
        }
        if ('last_name' in payload || 'lastname' in payload || 'lname' in payload) {
          payload.last_name = profile.lastName;
          payload.lastname = profile.lastName;
          payload.lname = profile.lastName;
        }

        const reqConfig = {
          timeout: 12000,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: url
          }
        };

        if (method === 'get') await axios.get(actionUrl, { ...reqConfig, params: payload });
        else await axios.post(actionUrl, new URLSearchParams(payload), reqConfig);

        logger.info(` [OK] ${brandName}: HTTP fallback submitted signup form (${actionUrl})`);
        return {
          success: true,
          formUrl: actionUrl,
          espProvider: esp,
          strategy: 'http_form_fallback',
          error: null
        };
      }
    } catch (err) {
      logger.debug(`HTTP signup fallback failed for ${url}: ${err.message}`);
    }
  }

  return {
    success: false,
    formUrl: null,
    espProvider: 'unknown',
    strategy: 'http_form_fallback',
    error: 'HTTP fallback did not find or submit a valid signup form'
  };
}

// -- Strategy Implementations ----------------------------------
async function tryDedicatedSignupPage(page, baseUrl, profile, brandName) {
  const base = baseUrl.replace(/\/$/, '');
  for (const path of SIGNUP_PAGE_PATTERNS) {
    try {
      const url = base + path;
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      if (!res || res.status() >= 400) continue;
      await sleep(1500);
      const blocker = await detectSiteBlocker(page);
      if (blocker) {
        if (blocker.reason === 'site_waitroom_page') {
          await sleep(6000);
          const blockerAfterWait = await detectSiteBlocker(page);
          if (blockerAfterWait) return { success: false, reason: blockerAfterWait.reason, diagnostic: blockerAfterWait.diagnostic };
        } else {
          return { success: false, reason: blocker.reason, diagnostic: blocker.diagnostic };
        }
      }
      const filled = await fillEmailForm(page, profile, brandName);
      if (filled.success) {
        return { success: true, formUrl: url, espProvider: detectFromHtml(await page.content()) };
      }
      if (filled.reason === 'captcha_challenge_present') {
        return { success: false, reason: filled.reason, diagnostic: filled.diagnostic || null };
      }
    } catch {
      continue;
    }
  }
  return { success: false, reason: 'dedicated_page_no_newsletter_form' };
}

async function tryFooterForm(page, websiteUrl, profile, brandName) {
  try {
    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1200);
    const initialBlocker = await detectSiteBlocker(page);
    if (initialBlocker) return { success: false, reason: initialBlocker.reason, diagnostic: initialBlocker.diagnostic };

    for (let attempt = 1; attempt <= 3; attempt++) {
      await dismissOverlays(page);
      await sleep(350);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
      await page.evaluate((n) => {
        const ratio = n === 1 ? 1 : n === 2 ? 0.9 : 0.8;
        window.scrollTo(0, Math.floor(document.body.scrollHeight * ratio));
      }, attempt);
      await sleep(1000);
      const blocker = await detectSiteBlocker(page);
      if (blocker) return { success: false, reason: blocker.reason, diagnostic: blocker.diagnostic };

      const emailInput = await findEmailInput(page, { preferFooter: true, requireNewsletterContext: true });
      if (!emailInput) continue;
      const fillResult = await fillEmailForm(page, profile, brandName, emailInput);
      if (fillResult.success) {
        return { success: true, formUrl: websiteUrl, espProvider: detectFromHtml(await page.content()) };
      }
      if (fillResult.reason === 'captcha_challenge_present') {
        return { success: false, reason: fillResult.reason, diagnostic: fillResult.diagnostic || null };
      }
    }
  } catch (err) {
    logger.debug(`Footer form strategy failed: ${err.message}`);
  }
  return { success: false, reason: 'footer_newsletter_form_not_found' };
}

async function tryPopupForm(page, websiteUrl, profile, brandName) {
  try {
    const currentUrl = page.url();
    if (!currentUrl.includes(websiteUrl.replace(/https?:\/\//, '').split('/')[0])) {
      await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    await sleep(2000);
    const initialBlocker = await detectSiteBlocker(page);
    if (initialBlocker) return { success: false, reason: initialBlocker.reason, diagnostic: initialBlocker.diagnostic };
    await page.mouse.move(640, 400);
    await sleep(500);
    await page.mouse.move(640, 100);
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, window.innerHeight * 0.5));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1500);
    await dismissOverlays(page);
    await sleep(700);
    const blocker = await detectSiteBlocker(page);
    if (blocker) return { success: false, reason: blocker.reason, diagnostic: blocker.diagnostic };

    const emailInput = await findEmailInput(page, { requireNewsletterContext: true });
    if (!emailInput) return { success: false, reason: 'popup_email_input_not_found' };

    const fillResult = await fillEmailForm(page, profile, brandName, emailInput);
    if (fillResult.success) {
      return { success: true, formUrl: websiteUrl, espProvider: detectFromHtml(await page.content()) };
    }
    if (fillResult.reason === 'captcha_challenge_present') {
      return { success: false, reason: fillResult.reason, diagnostic: fillResult.diagnostic || null };
    }
  } catch (err) {
    logger.debug(`Popup strategy failed: ${err.message}`);
  }
  return { success: false, reason: 'popup_submission_failed' };
}

async function tryContextualForm(page, websiteUrl, profile, brandName) {
  try {
    const currentUrl = page.url();
    if (!currentUrl.includes(websiteUrl.replace(/https?:\/\//, '').split('/')[0])) {
      await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1800);
    }
    const initialBlocker = await detectSiteBlocker(page);
    if (initialBlocker) return { success: false, reason: initialBlocker.reason, diagnostic: initialBlocker.diagnostic };
    await dismissOverlays(page);
    await sleep(600);
    const blocker = await detectSiteBlocker(page);
    if (blocker) return { success: false, reason: blocker.reason, diagnostic: blocker.diagnostic };
    const emailInput = await findEmailInput(page, { requireNewsletterContext: true });
    if (!emailInput) return { success: false, reason: 'contextual_email_input_not_found' };
    const fillResult = await fillEmailForm(page, profile, brandName, emailInput);
    if (!fillResult.success) {
      return {
        success: false,
        reason: fillResult.reason === 'captcha_challenge_present' ? fillResult.reason : 'contextual_form_submit_failed',
        diagnostic: fillResult.diagnostic || null
      };
    }
    return { success: true, formUrl: websiteUrl, espProvider: detectFromHtml(await page.content()) };
  } catch (err) {
    logger.debug(`Contextual form strategy failed: ${err.message}`);
    return { success: false, reason: 'contextual_strategy_exception' };
  }
}

async function tryNewsletterLinkPages(page, websiteUrl, profile, brandName) {
  try {
    const baseOrigin = getBaseOrigin(websiteUrl);
    if (!baseOrigin) return { success: false, reason: 'invalid_base_url' };
    const currentUrl = page.url();
    if (!currentUrl || !isSameSiteUrl(currentUrl, baseOrigin)) {
      await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1200);
    }
    await dismissOverlays(page);
    await sleep(400);
    const blocker = await detectSiteBlocker(page);
    if (blocker) return { success: false, reason: blocker.reason, diagnostic: blocker.diagnostic };

    const candidateLinks = await page.evaluate((origin) => {
      const positive = ['newsletter', 'subscribe', 'sign up', 'signup', 'join', 'vip', 'updates', 'stay connected', 'email'];
      const negative = ['login', 'account', 'cart', 'checkout', 'privacy', 'returns', 'unsubscribe'];
      const scores = new Map();
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const el of links) {
        const hrefRaw = el.getAttribute('href') || '';
        if (!hrefRaw || hrefRaw.startsWith('#') || hrefRaw.startsWith('mailto:') || hrefRaw.startsWith('tel:')) continue;
        let url;
        try {
          url = new URL(hrefRaw, window.location.href);
        } catch {
          continue;
        }
        if (url.origin !== origin) continue;
        const text = (el.textContent || '').toLowerCase();
        const token = `${text} ${url.pathname.toLowerCase()} ${url.search.toLowerCase()}`;
        if (negative.some((n) => token.includes(n))) continue;
        let score = 0;
        if (positive.some((p) => text.includes(p))) score += 4;
        if (positive.some((p) => url.pathname.toLowerCase().includes(p))) score += 5;
        if (url.pathname.toLowerCase().includes('/pages/')) score += 1;
        if (score <= 0) continue;
        const existing = scores.get(url.toString()) || 0;
        scores.set(url.toString(), Math.max(existing, score));
      }
      return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([url]) => url);
    }, baseOrigin);

    for (const url of candidateLinks) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(1200);
        await dismissOverlays(page);
        await sleep(350);
        const linkBlocker = await detectSiteBlocker(page);
        if (linkBlocker) {
          if (linkBlocker.reason === 'cloudflare_challenge_page') {
            return { success: false, reason: linkBlocker.reason, diagnostic: linkBlocker.diagnostic };
          }
          continue;
        }
        const emailInput = await findEmailInput(page, { requireNewsletterContext: false });
        if (!emailInput) continue;
        const fillResult = await fillEmailForm(page, profile, brandName, emailInput);
        if (fillResult.success) {
          return { success: true, formUrl: url, espProvider: detectFromHtml(await page.content()) };
        }
        if (fillResult.reason === 'captcha_challenge_present') {
          return { success: false, reason: fillResult.reason, diagnostic: fillResult.diagnostic || null };
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    logger.debug(`Newsletter link page strategy failed: ${err.message}`);
  }
  return { success: false, reason: 'newsletter_link_pages_not_found' };
}

// -- Form Filling Helpers --------------------------------------
async function findEmailInput(page, options = {}) {
  let best = null;
  let bestScore = -100;
  const contexts = [page, ...page.frames()];

  for (const context of contexts) {
    const isFrame = context !== page;
    let inputs = [];
    try {
      inputs = await context.$$(FORM_SELECTORS.join(','));
    } catch {
      continue;
    }

    for (const input of inputs) {
      try {
        if (!(await input.isVisible())) continue;
        const score = await input.evaluate((el, opts) => {
          const hints = ['newsletter', 'subscribe', 'sign up', 'join', 'updates', 'stay in touch', 'email address', 'grow your mind'];
          const negativeHints = ['search', 'contact us', 'support', 'order', 'checkout'];
          const attrBlob = [
            el.getAttribute('name') || '',
            el.getAttribute('id') || '',
            el.getAttribute('class') || '',
            el.getAttribute('placeholder') || '',
            el.getAttribute('aria-label') || ''
          ].join(' ').toLowerCase();

          const container = el.closest('form, footer, section, aside, div');
          const containerText = (container?.textContent || '').toLowerCase().slice(0, 2500);
          const inFooter = !!el.closest('footer');
          let scoreValue = 0;

          if (attrBlob.includes('email')) scoreValue += 3;
          if (hints.some((h) => containerText.includes(h) || attrBlob.includes(h))) scoreValue += 5;
          if (negativeHints.some((h) => containerText.includes(h) && !containerText.includes('newsletter'))) scoreValue -= 5;
          if (containerText.includes('privacy policy') || containerText.includes('unsubscribe')) scoreValue += 2;
          if (opts.preferFooter && inFooter) scoreValue += 3;
          if (opts.requireNewsletterContext && !hints.some((h) => containerText.includes(h) || attrBlob.includes(h))) scoreValue -= 8;
          return scoreValue;
        }, options);

        const adjustedScore = isFrame ? score + 2 : score;
        if (adjustedScore > bestScore) {
          best = input;
          bestScore = adjustedScore;
        }
      } catch {
        continue;
      }
    }
  }

  if (!best) return null;
  if (options.requireNewsletterContext && bestScore < 1) return null;
  return best;
}

async function fillEmailForm(page, profile, brandName, existingEmailInput = null) {
  try {
    const emailInput = existingEmailInput || await findEmailInput(page);
    if (!emailInput) return { success: false, reason: 'email_input_not_found', diagnostic: null };

    const formHandle = await emailInput.evaluateHandle((el) => el.closest('form'));
    const hasForm = await formHandle.evaluate((form) => !!form).catch(() => false);
    if (!hasForm) {
      return { success: false, reason: 'email_input_form_not_found', diagnostic: null };
    }

    const [emailMeta, preCaptchaState] = await Promise.all([
      emailInput.evaluate((el) => ({
        id: el.id || null,
        name: el.name || null,
        type: el.type || null,
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || null
      })),
      detectCaptchaState(formHandle)
    ]);

    await emailInput.click({ delay: 100 });
    await emailInput.fill('');
    await sleep(300);
    await emailInput.type(EMAIL, { delay: randomDelay(40, 100) });
    await sleep(500);
    await fillAdditionalFormFields(formHandle, profile);

    await sleep(500);
    const submitResult = await submitForm(emailInput, formHandle);
    if (!submitResult.submitted) {
      return {
        success: false,
        reason: 'form_submit_not_found',
        diagnostic: {
          emailInput: emailMeta,
          preCaptchaState,
          submitResult
        }
      };
    }

    const postCaptchaState = await detectCaptchaState(formHandle);
    if (isPotentialCaptchaState(postCaptchaState)) {
      return {
        success: false,
        reason: 'captcha_challenge_present',
        diagnostic: {
          emailInput: emailMeta,
          preCaptchaState,
          postCaptchaState,
          submitResult
        }
      };
    }

    const success = await detectSignupSuccess(page, brandName, formHandle);
    if (!success) {
      return {
        success: false,
        reason: 'form_submission_not_confirmed',
        diagnostic: {
          emailInput: emailMeta,
          preCaptchaState,
          postCaptchaState,
          submitResult
        }
      };
    }

    return {
      success: true,
      reason: null,
      diagnostic: {
        emailInput: emailMeta,
        preCaptchaState,
        postCaptchaState,
        submitResult
      }
    };
  } catch (err) {
    logger.debug(`Form fill failed: ${err.message}`);
    return { success: false, reason: 'form_fill_exception', diagnostic: { error: err.message } };
  }
}

async function fillAdditionalFormFields(formHandle, profile) {
  const inputs = await formHandle.$$('input:not([type="hidden"]):not([type="email"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])');

  for (const input of inputs) {
    try {
      const visible = await input.isVisible();
      if (!visible) continue;

      const attrs = await input.evaluate(el => ({
        name: el.name || '',
        placeholder: el.placeholder || '',
        id: el.id || '',
        label: el.getAttribute('aria-label') || '',
        type: el.type || 'text'
      }));

      const hints = [attrs.name, attrs.placeholder, attrs.id, attrs.label].join(' ').toLowerCase();
      const value = matchFieldToProfile(hints, profile);
      if (value) {
        await input.click({ delay: 80 });
        await input.fill(String(value));
        await sleep(randomDelay(200, 600));
      }
    } catch {
      continue;
    }
  }

  const selects = await formHandle.$$('select');
  for (const select of selects) {
    try {
      const visible = await select.isVisible();
      if (!visible) continue;

      const attrs = await select.evaluate(el => ({
        name: el.name || '',
        id: el.id || '',
        label: el.getAttribute('aria-label') || ''
      }));

      const hints = [attrs.name, attrs.id, attrs.label].join(' ').toLowerCase();
      const value = matchFieldToProfile(hints, profile);
      if (value) {
        await select.selectOption({ label: new RegExp(value, 'i') }).catch(() =>
          select.selectOption({ value: String(value) }).catch(() => {})
        );
        await sleep(randomDelay(200, 500));
      }
    } catch {
      continue;
    }
  }

  const checkboxes = await formHandle.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      const visible = await cb.isVisible();
      if (!visible) continue;
      const isChecked = await cb.isChecked();
      if (!isChecked) await cb.check({ timeout: 3000 });
      await sleep(200);
    } catch {
      continue;
    }
  }
}

async function submitForm(emailInput, formHandle = null) {
  const root = formHandle || await emailInput.evaluateHandle((el) => el.closest('form'));

  for (const selector of SUBMIT_SELECTORS) {
    try {
      const btn = await root.$(selector);
      if (btn && await btn.isVisible()) {
        const submitMeta = await btn.evaluate((el, sel) => ({
          selector: sel,
          tag: el.tagName || null,
          id: el.id || null,
          name: el.getAttribute('name') || null,
          type: el.getAttribute('type') || null,
          ariaLabel: el.getAttribute('aria-label') || null
        }), selector);
        await btn.click({ delay: 100 });
        return { submitted: true, method: 'button_click', submitMeta };
      }
    } catch {
      continue;
    }
  }
  try {
    await emailInput.press('Enter');
    return { submitted: true, method: 'enter_key', submitMeta: null };
  } catch {
    // Last fallback for forms with custom button wiring.
    try {
      const triggerResult = await root.evaluate((form) => {
        if (!form) return { ok: false };
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return { ok: true, method: 'request_submit' };
        }
        if (typeof form.submit === 'function') {
          form.submit();
          return { ok: true, method: 'native_submit' };
        }
        return { ok: false };
      });
      if (triggerResult?.ok) {
        return { submitted: true, method: triggerResult.method || 'form_submit_fallback', submitMeta: null };
      }
    } catch {
      // no-op
    }
    return { submitted: false, method: null, submitMeta: null };
  }
}

async function detectCaptchaState(formHandle) {
  return formHandle.evaluate((form) => {
    if (!form) return {};
    const hCaptcha = form.querySelector('textarea[name="h-captcha-response"], input[name="h-captcha-response"]');
    const recaptcha = form.querySelector('textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"], textarea[name="recaptcha-v3-token"], input[name="recaptcha-v3-token"]');
    const captchaIframe = form.querySelector('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha" i]');
    return {
      formId: form.id || null,
      formAction: form.getAttribute('action') || null,
      formMethod: form.getAttribute('method') || null,
      hcaptchaBound: String(form.dataset?.hcaptchaBound || '') === 'true',
      recaptchaBound: String(form.dataset?.recaptchaBound || '') === 'true',
      hasHcaptchaContainer: !!form.querySelector('.h-captcha, [data-sitekey]'),
      hasHCaptchaInput: !!hCaptcha,
      hasRecaptchaInput: !!recaptcha,
      hasCaptchaIframe: !!captchaIframe,
      hCaptchaValueLen: (hCaptcha?.value || '').trim().length,
      recaptchaValueLen: (recaptcha?.value || '').trim().length
    };
  }).catch(() => ({}));
}

async function detectSignupSuccess(page, brandName, formHandle = null) {
  await Promise.race([
    page.waitForTimeout(3000),
    page.waitForNavigation({ timeout: 5000, waitUntil: 'networkidle' }).catch(() => {})
  ]);

  const currentUrl = (page.url() || '').toLowerCase();
  const pageText = (await page.textContent('body').catch(() => '')).toLowerCase();
  const formState = formHandle
    ? await formHandle.evaluate((form) => {
      if (!form) return null;
      const statusNodes = form.querySelectorAll('[role="alert"], [aria-live], .alert, .errors, .form-status, [data-form-status]');
      const statusText = Array.from(statusNodes).map((n) => (n.textContent || '').trim()).join(' ').toLowerCase();
      const formText = (form.textContent || '').toLowerCase();
      const invalidCount = form.querySelectorAll(':invalid').length;
      return { statusText, formText, invalidCount };
    }).catch(() => null)
    : null;

  const successPatterns = [
    'thank you', 'thanks for', 'success', 'confirmed',
    "you're subscribed", 'you are subscribed', 'check your email',
    'welcome to', 'almost there', "you're in", 'signed up',
    'added to', 'subscribed to', 'customer_posted=true', 'contact_posted=true', 'posted_successfully=true'
  ];

  const alreadySubscribed = ['already subscribed', 'already on our list', 'already signed up'];
  if (alreadySubscribed.some(p => pageText.includes(p))) {
    logger.info(` [i] ${brandName}: already subscribed`);
    return 'already_subscribed';
  }

  if (successPatterns.some(p => pageText.includes(p))) {
    logger.info(` [OK] ${brandName}: signup confirmed on page`);
    return true;
  }

  if (successPatterns.some((p) => currentUrl.includes(p))) {
    logger.info(` [OK] ${brandName}: signup confirmed via URL markers`);
    return true;
  }

  const formErrorText = `${formState?.statusText || ''} ${formState?.formText || ''}`;
  const errorPatterns = ['invalid email', 'please enter', 'required', 'captcha', 'something went wrong', 'unable to submit'];
  if ((formState?.invalidCount || 0) > 0 || errorPatterns.some((p) => formErrorText.includes(p))) {
    logger.debug(` [ERR] ${brandName}: error detected on page`);
    return false;
  }

  logger.info(` [OK] ${brandName}: form submitted (no error detected)`);
  return true;
}

async function dismissOverlays(page) {
  const dismissSelectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("I Accept")',
    'button:has-text("OK")',
    'button:has-text("Close")',
    '[class*="close" i]',
    '[aria-label="Close" i]',
    '[class*="cookie" i] button',
    '[class*="gdpr" i] button',
    '[id*="cookie" i] button',
    '#onetrust-accept-btn-handler',
    '.cc-btn.cc-allow',
    '.cookie-accept',
    '.klaviyo-close-form',
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
    '[data-testid*="close" i]',
    '[class*="modal" i] [class*="close" i]',
    '[id*="modal" i] [class*="close" i]'
  ];

  for (const sel of dismissSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click({ timeout: 2000 });
        await sleep(500);
        break;
      }
    } catch {
      continue;
    }
  }

  // As a fallback, attempt to close obvious full-screen blockers.
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('div,section,aside,[role="dialog"]'));
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      const isFixed = style.position === 'fixed' || style.position === 'sticky';
      const z = Number(style.zIndex || 0);
      const rect = el.getBoundingClientRect();
      const coversViewport = rect.width >= window.innerWidth * 0.75 && rect.height >= window.innerHeight * 0.55;
      if (!isFixed || z < 20 || !coversViewport) continue;
      const txt = (el.textContent || '').toLowerCase();
      if (txt.includes('subscribe') || txt.includes('sign up') || txt.includes('newsletter') ||
          txt.includes('cookie') || txt.includes('privacy')) {
        const closeBtn = el.querySelector('button,[role="button"],[aria-label*="close" i],[class*="close" i]');
        if (closeBtn) {
          closeBtn.click();
        } else {
          el.style.display = 'none';
        }
      }
    }
  }).catch(() => {});
}

// -- Klaviyo API Fallback --------------------------------------
async function tryKlaviyoApi(companyId, email, brandName) {
  try {
    const response = await axios.post(
      'https://manage.kmail-lists.com/ajax/subscriptions/subscribe',
      {
        g: companyId,
        email,
        $fields: '$email',
        $source: 'Website Newsletter'
      },
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `https://www.${brandName.toLowerCase().replace(/\s+/g, '')}.com`
        },
        timeout: 10000
      }
    );
    const data = response.data;
    const success = data?.success === true || data?.result === 'added' || data?.result === 'already_in_list';
    if (success) logger.info(` [OK] ${brandName}: Klaviyo API signup successful`);
    return { success, reason: success ? null : 'klaviyo_api_rejected' };
  } catch (err) {
    logger.debug(`Klaviyo API fallback failed: ${err.message}`);
    return { success: false, reason: 'klaviyo_api_failed' };
  }
}

async function tryMailchimpForm(page, profile) {
  try {
    const emailInput = await page.$('#mce-EMAIL, input[name="EMAIL"]');
    if (!emailInput || !await emailInput.isVisible()) return { success: false, reason: 'mailchimp_email_input_not_found' };

    await emailInput.fill(profile.email);
    await sleep(500);

    const fInput = await page.$('#mce-FNAME, input[name="FNAME"]');
    const lInput = await page.$('#mce-LNAME, input[name="LNAME"]');
    if (fInput) await fInput.fill(profile.firstName);
    if (lInput) await lInput.fill(profile.lastName);

    const submitBtn = await page.$('#mc-embedded-subscribe, input[value*="Subscribe" i]');
    if (submitBtn) await submitBtn.click({ delay: 100 });

    await sleep(2500);
    return { success: true, reason: null };
  } catch {
    return { success: false, reason: 'mailchimp_submit_failed' };
  }
}

// -- Helpers ---------------------------------------------------
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { signUpForNewsletter };
