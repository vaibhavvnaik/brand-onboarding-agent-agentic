const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

let runtimeState = {
  checkedAt: null,
  ready: false,
  reason: 'not_checked',
  autoInstallAttempted: false,
  autoInstallDepsAttempted: false
};

let checkingPromise = null;

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function withLibraryPaths() {
  const libPaths = [
    path.join(__dirname, '../.local-libs/usr/lib/x86_64-linux-gnu'),
    path.join(__dirname, '../.local-libs/lib/x86_64-linux-gnu')
  ].map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));

  const systemPaths = [
    '/usr/lib/x86_64-linux-gnu',
    '/lib/x86_64-linux-gnu',
    '/usr/lib64',
    '/lib64'
  ].filter((p) => fs.existsSync(p));

  const existing = process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : [];
  process.env.LD_LIBRARY_PATH = Array.from(new Set([...libPaths, ...systemPaths, ...existing.filter(Boolean)])).join(':');
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

function getExecutablePathSafe() {
  try {
    const { chromium } = require('playwright');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

function tryInstallChromium() {
  runtimeState.autoInstallAttempted = true;
  const installCmd = `${process.execPath} ./node_modules/playwright/cli.js install chromium`;
  logger.warn(`[runtime] Playwright browser missing; attempting auto-install: ${installCmd}`);
  execSync(installCmd, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env
  });
}

function tryInstallChromiumWithDeps() {
  runtimeState.autoInstallDepsAttempted = true;
  const installCmd = `${process.execPath} ./node_modules/playwright/cli.js install --with-deps chromium`;
  logger.warn(`[runtime] Missing Playwright shared libs detected; attempting deps install: ${installCmd}`);
  execSync(installCmd, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env
  });
}

function isSharedLibError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('error while loading shared libraries') ||
    msg.includes('libglib') ||
    msg.includes('libnspr') ||
    msg.includes('libnss3') ||
    msg.includes('libx11') ||
    msg.includes('libgbm') ||
    msg.includes('libdrm')
  );
}

function isSpawnResourceError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('spawn') && (msg.includes('eagain') || msg.includes('resource temporarily unavailable'));
}

function killStalePlaywrightChromium() {
  const cmd = 'pkill -f "chromium_headless_shell|chrome-headless-shell|playwright_chromiumdev_profile" || true';
  logger.warn(`[runtime] Attempting Chromium cleanup: ${cmd}`);
  execSync(cmd, { stdio: 'ignore', env: process.env });
}

async function launchSmokeTest() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await browser.close();
}

async function ensurePlaywrightRuntimeReady({ autoInstall = true } = {}) {
  if (checkingPromise) return checkingPromise;

  checkingPromise = (async () => {
    withLibraryPaths();
    const installAllowed = autoInstall && envFlag('PLAYWRIGHT_PREFLIGHT_AUTO_INSTALL', true);
    runtimeState.checkedAt = new Date();

    try {
      let execPath = getExecutablePathSafe();
      if (!execPath || !fs.existsSync(execPath)) {
        if (installAllowed) {
          tryInstallChromium();
          execPath = getExecutablePathSafe();
        } else {
          logger.warn('[runtime] Playwright browser missing and runtime auto-install disabled. Ensure Chromium is installed at build time.');
        }
      }

      if (!execPath || !fs.existsSync(execPath)) {
        runtimeState.ready = false;
        runtimeState.reason = 'playwright_executable_missing';
        logger.error('[runtime] Playwright executable missing after preflight.');
        return runtimeState;
      }

      try {
        await launchSmokeTest();
        runtimeState.ready = true;
        runtimeState.reason = 'ok';
        logger.info('[runtime] Playwright preflight passed (launch smoke test succeeded).');
      } catch (err) {
        if (isSpawnResourceError(err)) {
          try {
            killStalePlaywrightChromium();
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await launchSmokeTest();
            runtimeState.ready = true;
            runtimeState.reason = 'ok';
            logger.warn('[runtime] Playwright preflight recovered after Chromium cleanup.');
            return runtimeState;
          } catch (retryErr) {
            runtimeState.ready = false;
            runtimeState.reason = retryErr.message;
            logger.error(`[runtime] Playwright preflight failed after cleanup retry: ${retryErr.message}`);
            return runtimeState;
          }
        }
        if (installAllowed && isSharedLibError(err)) {
          try {
            tryInstallChromiumWithDeps();
            await launchSmokeTest();
            runtimeState.ready = true;
            runtimeState.reason = 'ok';
            logger.info('[runtime] Playwright preflight recovered after dependency install.');
            return runtimeState;
          } catch (retryErr) {
            runtimeState.ready = false;
            runtimeState.reason = retryErr.message;
            logger.error(`[runtime] Playwright preflight failed after deps install retry: ${retryErr.message}`);
            return runtimeState;
          }
        }
        runtimeState.ready = false;
        runtimeState.reason = err.message;
        logger.error(`[runtime] Playwright preflight failed: ${err.message}`);
      }
      return runtimeState;
    } catch (err) {
      runtimeState.ready = false;
      runtimeState.reason = err.message;
      logger.error(`[runtime] Playwright preflight crashed: ${err.message}`);
      return runtimeState;
    } finally {
      checkingPromise = null;
    }
  })();

  return checkingPromise;
}

function getPlaywrightRuntimeStatus() {
  return { ...runtimeState };
}

module.exports = { ensurePlaywrightRuntimeReady, getPlaywrightRuntimeStatus };
