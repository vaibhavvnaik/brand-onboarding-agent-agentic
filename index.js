/**
 * Brand Onboarding Agent - Railway Server Entry Point
 *
 * Runs as a pure web server (no CLI).
 * Visit /setup to connect Gmail via OAuth (no terminal needed).
 * Visit /dashboard for the admin UI.
 */

// Prevent unhandled promise rejections from crashing Node.js 15+
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection] Unhandled promise rejection:', reason);
  // Do NOT exit - keep server running
});

require('dotenv').config();
const express   = require('express');
const session   = require('express-session');
const MongoStore = require('connect-mongo');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const os        = require('os');

const { connectDB } = require('./config/database');
const { validateRequiredEnv } = require('./config/env');
const logger        = require('./utils/logger');
const WorkflowRun   = require('./models/WorkflowRun');
const { runJob }    = require('./jobs/runJob');
const { appendActivityLog } = require('./utils/activityLog');
const { ensurePlaywrightRuntimeReady } = require('./utils/runtimePreflight');
const apiRoutes     = require('./routes/api');
const adminRoutes   = require('./routes/admin');
const setupRoutes   = require('./routes/setup');

const app  = express();
const PORT = process.env.PORT || 3000;

const schedulerStepState = new Map();

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getStepTimeoutMs(step) {
  const defaultMinutes = readNumberEnv('INTERNAL_CRON_STEP_TIMEOUT_MIN', 12);
  const defaultMs = Math.max(1, defaultMinutes) * 60 * 1000;
  const specificKey = `INTERNAL_CRON_STEP_TIMEOUT_MIN_${String(step || '').toUpperCase()}`;
  const specificMinutes = readNumberEnv(specificKey, NaN);
  if (Number.isFinite(specificMinutes) && specificMinutes > 0) {
    return specificMinutes * 60 * 1000;
  }
  return defaultMs;
}

function getStepLockTtlMs() {
  return Math.max(
    getStepTimeoutMs('default') * 2,
    readNumberEnv('INTERNAL_CRON_STEP_LOCK_TTL_MIN', 30) * 60 * 1000
  );
}

async function recoverStaleRunningWorkflowRuns() {
  const ttlMs = getStepLockTtlMs();
  const staleBefore = new Date(Date.now() - ttlMs);
  const result = await WorkflowRun.updateMany(
    {
      trigger: 'scheduler',
      status: 'running',
      startedAt: { $lt: staleBefore }
    },
    {
      $set: {
        status: 'failed',
        error: `scheduler_step_stale_timeout:${Math.round(ttlMs / 60000)}m`,
        completedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );
  const modified = Number(result?.modifiedCount || 0);
  if (modified > 0) {
    logger.warn(`[scheduler] Recovered ${modified} stale running workflow rows older than ${Math.round(ttlMs / 60000)}m`);
  }
  return modified;
}

async function runStepWithTracking(step, options = {}) {
  const existingLock = schedulerStepState.get(step);
  const lockTtlMs = getStepLockTtlMs();
  if (existingLock?.locked) {
    const ageMs = Date.now() - existingLock.startedAt.getTime();
    if (ageMs <= lockTtlMs) {
      return { step, status: 'skipped', reason: 'already_running' };
    }
    logger.error(`[scheduler] Clearing stale in-memory lock for ${step}; age=${Math.round(ageMs / 1000)}s`);
  }

  schedulerStepState.set(step, { locked: true, startedAt: new Date() });
  const startedAt = new Date();
  let runRow = null;
  const runtimeMeta = {
    hostname: os.hostname(),
    pid: process.pid,
    serviceName: process.env.RAILWAY_SERVICE_NAME || null,
    publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || null
  };
  try {
    runRow = await WorkflowRun.create({
      step,
      trigger: 'scheduler',
      status: 'running',
      startedAt,
      meta: { options, runtime: runtimeMeta }
    });
  } catch {
    // non-fatal
  }

  try {
    const timeoutMs = getStepTimeoutMs(step);
    const result = await Promise.race([
      runJob(step, options),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`scheduler_step_timeout:${step}:${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      })
    ]);
    if (runRow) {
      runRow.status = 'success';
      runRow.completedAt = new Date();
      runRow.durationMs = runRow.completedAt.getTime() - startedAt.getTime();
      runRow.summary = result;
      await runRow.save();
    }
    return { step, status: 'success', result };
  } catch (err) {
    if (runRow) {
      runRow.status = 'failed';
      runRow.completedAt = new Date();
      runRow.durationMs = runRow.completedAt.getTime() - startedAt.getTime();
      runRow.error = err.message;
      await runRow.save();
    }
    return { step, status: 'failed', error: err.message };
  } finally {
    schedulerStepState.set(step, { locked: false, startedAt: null });
  }
}

function startInternalScheduler() {
  const enabled = (process.env.INTERNAL_CRON_ENABLED || 'true').toLowerCase() !== 'false';
  const schedulerServiceName = String(process.env.INTERNAL_CRON_SERVICE_NAME || '').trim();
  const currentServiceName = String(process.env.RAILWAY_SERVICE_NAME || process.env.SERVICE_NAME || '').trim();
  const intervalMin = Number(process.env.INTERNAL_CRON_INTERVAL_MIN || 10);
  const intervalMs = Math.max(1, intervalMin) * 60 * 1000;
  const maxCycleMin = Number(process.env.INTERNAL_CRON_MAX_CYCLE_MIN || 25);
  const maxCycleMs = Math.max(intervalMs, Math.max(5, maxCycleMin) * 60 * 1000);
  const initialDelaySec = Number(process.env.INTERNAL_CRON_INITIAL_DELAY_SEC || 30);
  const options = {
    batchSize: Number(process.env.INTERNAL_CRON_BATCH_SIZE || process.env.BATCH_SIZE || 10),
    inboxHours: Number(process.env.INTERNAL_CRON_INBOX_HOURS || process.env.SCAN_HOURS || 24),
    maxInboxResults: Number(process.env.INTERNAL_CRON_MAX_INBOX_RESULTS || process.env.SCAN_MAX_RESULTS || 0),
    limit: Number(process.env.INTERNAL_CRON_STEP_LIMIT || 50),
    retryMissingScreenshotsLimit: Number(process.env.INTERNAL_CRON_RETRY_MISSING_SCREENSHOTS_LIMIT || 50)
  };
  const discoverEveryCycles = Math.max(1, Number(process.env.INTERNAL_CRON_DISCOVER_EVERY_CYCLES || 1));
  let cycleCount = 0;
  let cycleInProgress = false;
  let cycleStartedAt = null;

  if (!enabled) {
    logger.info('[scheduler] Internal scheduler disabled (INTERNAL_CRON_ENABLED=false)');
    return;
  }

  if (schedulerServiceName && currentServiceName && schedulerServiceName !== currentServiceName) {
    logger.info(`[scheduler] Internal scheduler disabled on this service (expected service="${schedulerServiceName}", current="${currentServiceName}")`);
    return;
  }

  const tick = async () => {
    if (cycleInProgress) {
      const elapsedMs = cycleStartedAt ? Date.now() - cycleStartedAt.getTime() : 0;
      if (elapsedMs < maxCycleMs) {
        logger.warn('[scheduler] Previous cycle still running; skipping this tick');
        return;
      }
      logger.error(`[scheduler] Previous cycle exceeded max duration (${Math.round(elapsedMs / 1000)}s); clearing scheduler lock`);
      cycleInProgress = false;
      cycleStartedAt = null;
    }

    cycleInProgress = true;
    cycleCount += 1;
    const startedAt = new Date();
    cycleStartedAt = startedAt;
    logger.info(`[scheduler] Starting internal cycle (every ${intervalMin} min)`);
    appendActivityLog({
      source: 'job',
      level: 'info',
      phase: 'scheduler',
      message: 'Internal scheduler cycle started',
      meta: { intervalMin, options, startedAt }
    });

    try {
      const results = [];
      if (cycleCount % discoverEveryCycles === 0) {
        results.push(await runStepWithTracking('discover_and_signup', options));
      } else {
        results.push({
          step: 'discover_and_signup',
          status: 'skipped',
          reason: `discover cadence (${discoverEveryCycles} cycles)`
        });
      }
      results.push(await runStepWithTracking('recover_failed_signups', options));
      results.push(await runStepWithTracking('scan_inbox', options));
      results.push(await runStepWithTracking('process_confirmations', options));
      results.push(await runStepWithTracking('ingest_newsletters', options));
      results.push(await runStepWithTracking('retry_missing_screenshots', {
        ...options,
        limit: options.retryMissingScreenshotsLimit
      }));

      const hasFailure = results.some((r) => r.status !== 'success');
      const completedAt = new Date();
      appendActivityLog({
        source: 'job',
        level: hasFailure ? 'warn' : 'success',
        phase: 'scheduler',
        message: `Internal scheduler cycle ${hasFailure ? 'completed with failures' : 'completed successfully'}`,
        meta: {
          startedAt,
          completedAt,
          durationSec: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
          results
        }
      });
    } catch (err) {
      logger.error('[scheduler] Internal cycle failed', err);
      appendActivityLog({
        source: 'job',
        level: 'error',
        phase: 'scheduler',
        message: `Internal scheduler cycle crashed: ${err.message}`,
        meta: { startedAt }
      });
    } finally {
      cycleInProgress = false;
      cycleStartedAt = null;
    }
  };

  logger.info(`[scheduler] Enabled internal scheduler: every ${intervalMin} min`);
  setTimeout(() => { tick().catch(() => {}); }, Math.max(5, initialDelaySec) * 1000);
  setInterval(() => { tick().catch(() => {}); }, intervalMs);
}

function logDiscoveryRuntimeConfig() {
  const sourceRaw = String(process.env.DISCOVERY_SOURCE || 'ollama').toLowerCase();
  const source = sourceRaw === 'claude' ? 'ollama' : sourceRaw;
  const strictLlm = String(process.env.DISCOVERY_STRICT_LLM || process.env.DISCOVERY_STRICT_CLAUDE || 'false').toLowerCase() === 'true';
  const hasLlmConfig = !!(process.env.OLLAMA_BASE_URL || process.env.LLM_BASE_URL);
  logger.info(`[discovery] source=${source} llm_config=${hasLlmConfig ? 'present' : 'missing'} strict_llm=${strictLlm}`);
  if (!hasLlmConfig && source !== 'legacy' && source !== 'milled_only') {
    logger.warn('[discovery] LLM discovery env missing (OLLAMA_BASE_URL/LLM_BASE_URL). Discovery pool remains available; fresh LLM generation may fail.');
  }
}

function createSessionMiddleware() {
  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'brand-agent-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000
    }
  };

  if (isProduction && process.env.MONGODB_URI) {
    sessionConfig.store = MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: 'sessions',
      ttl: 24 * 60 * 60
    });
  }

  return session(sessionConfig);
}

// -- Main --------------------------------------------------------
(async () => {
  try {
    validateRequiredEnv();

    // Security middleware
    app.use(helmet({ contentSecurityPolicy: false }));

    // CORS
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);

    app.use(cors({
      origin: allowedOrigins.length
        ? (origin, cb) => {
            // Do not throw on disallowed origins; just omit CORS headers.
            // Throwing here bubbles into 500 responses for normal browser flows.
            if (!origin || origin === 'null' || allowedOrigins.includes(origin)) return cb(null, true);
            logger.warn(`CORS blocked origin: ${origin}`);
            return cb(null, false);
          }
        : true,
      credentials: true
    }));

    // Body parsing
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use('/artifacts', express.static(path.join(__dirname, 'artifacts'), { maxAge: '7d' }));

    // Session
    app.use(createSessionMiddleware());

// Trust Railway's proxy headers (fixes express-rate-limit ValidationError)
    app.set('trust proxy', 1);
    
    // Rate limiting
    app.use('/api/', rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: { error: 'Too many requests' }
    }));

    // Routes
    app.use('/api',   apiRoutes);
    // Primary dashboard routes (login/session-protected pages)
    app.use('/dashboard', adminRoutes);
    // Backwards-compatible alias
    app.use('/admin', adminRoutes);
    app.use('/setup', setupRoutes);

    // Health check
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        service: 'brand-onboarding-agent',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Root
    app.get('/', (req, res) => {
      res.json({
        service: 'Brand Onboarding Agent',
        version: '1.0.0',
        endpoints: {
          health:    '/health',
          api:       '/api',
          dashboard: '/dashboard',
          setup:     '/setup'
        }
      });
    });

    // Error handler
    app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    });

    // Start server FIRST - healthcheck will pass regardless of DB state
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Brand Agent server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info('Dashboard: /dashboard');
      logger.info('Setup:     /setup');
    });

    // Connect to MongoDB asynchronously (non-fatal)
    connectDB()
      .then(() => {
        logger.info('MongoDB connected successfully');
        recoverStaleRunningWorkflowRuns().catch((err) => {
          logger.warn(`[scheduler] Failed stale workflow recovery: ${err.message}`);
        });
        logDiscoveryRuntimeConfig();
        ensurePlaywrightRuntimeReady().then((runtime) => {
          logger.info(`[runtime] Playwright ready=${runtime.ready} reason=${runtime.reason}`);
        }).catch((err) => {
          logger.error(`[runtime] Playwright preflight call failed: ${err.message}`);
        });
        startInternalScheduler();
      })
      .catch(err => logger.error('MongoDB connection failed (server still running):', err.message));

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGINT',  () => { logger.info('SIGINT received, shutting down'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down'); process.exit(0); });
