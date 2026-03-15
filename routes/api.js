/**
 * REST API Routes - with live log streaming
 */
const express = require('express');
const router = express.Router();
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const { requireApiAuth } = require('../middleware/auth');
const { run } = require('../agents/brandOnboardingAgent');
const { fillDiscoveryPool, getDiscoveryPoolStats } = require('../services/brandDiscovery');
const { ensureBrandLogo } = require('../services/brandLogo');
const { scanRecentEmails } = require('../services/emailChangeDetector');
const { processInbox } = require('../services/inboxProcessor');
const { processPendingConfirmations } = require('../services/confirmationProcessor');
const {
  ingestPendingNewsletters,
  backfillListingsFromEmailMessages,
  retakeListingScreenshots,
  retryMissingScreenshotsForIngested
} = require('../services/newsletterIngestor');
const {
  runAgenticCycle,
  getAgenticRun,
  listAgenticRuns,
  approveAgenticRun,
  resumeAgenticRun
} = require('../services/agenticRuntime');
const { runEvalForAgentRun, listAgentEvals } = require('../services/agentEvals');
const { getAgentObservabilityOverview } = require('../services/agentObservability');
const { diagnoseAndHeal } = require('../services/agentDiagnostics');
const { runJob } = require('../jobs/runJob');
const logger = require('../utils/logger');
const ActivityLog = require('../models/ActivityLog');
const WorkflowRun = require('../models/WorkflowRun');
const { appendActivityLog } = require('../utils/activityLog');
const { getPlaywrightRuntimeStatus, ensurePlaywrightRuntimeReady } = require('../utils/runtimePreflight');

// -- Live Log System --------------------------------------------
const agentEmitter = new EventEmitter();
agentEmitter.setMaxListeners(100);

// Rolling in-memory log buffer (last 500 entries)
const LOG_BUFFER = [];
const MAX_LOGS = 500;
const AGENTIC_EVENT_BUFFER = new Map();
const AGENTIC_EVENT_LIMIT = 400;

function pushAgenticEvent(runId, event) {
  if (!runId) return;
  const list = AGENTIC_EVENT_BUFFER.get(runId) || [];
  const entry = { ...event, at: new Date().toISOString() };
  list.push(entry);
  if (list.length > AGENTIC_EVENT_LIMIT) list.shift();
  AGENTIC_EVENT_BUFFER.set(runId, list);
  agentEmitter.emit(`agentic:${runId}`, entry);
}

function pushLog(entry) {
  const log = { ...entry, timestamp: new Date().toISOString() };
  LOG_BUFFER.push(log);
  if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.shift();
  agentEmitter.emit('log', log);
  appendActivityLog({
    source: 'api_agent',
    level: entry.level || 'info',
    phase: entry.phase || 'general',
    message: entry.message || '',
    meta: { stats: entry.stats || null }
  });
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (!str.includes('"') && !str.includes(',') && !str.includes('\n')) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function recommendedManualAction(brand) {
  const code = String(brand.signupFailureCode || '').toLowerCase();
  const category = String(brand.signupFailureCategory || '').toLowerCase();
  if (code === 'captcha_challenge_present' || category === 'captcha_blocked') return 'manual_browser_signup_captcha';
  if (code === 'cloudflare_challenge_page') return 'manual_browser_signup_cloudflare';
  if (code === 'site_waitroom_page') return 'retry_later_waitroom_then_signup';
  if (code === 'all_strategies_exhausted') return 'manual_form_hunt_and_submit';
  return 'manual_review_required';
}

function compactAttemptSummary(brand) {
  const trace = brand?.signupFailureDiagnostic?.attemptTrace;
  if (!Array.isArray(trace) || !trace.length) return '';
  return trace
    .map((a) => `${a.strategy || 'unknown'}:${a.success ? 'ok' : 'fail'}${a.reason ? `:${a.reason}` : ''}`)
    .join(' | ');
}

function buildCoworkPrompt(row) {
  return [
    `Brand: ${row.name}`,
    `Website: ${row.websiteUrl}`,
    `Target email: ${row.subscriptionEmail}`,
    `Failure: ${row.signupFailureCategory}${row.signupFailureCode ? `/${row.signupFailureCode}` : ''}`,
    `Action: ${row.recommendedAction}`,
    row.signupFormUrl ? `Last form URL: ${row.signupFormUrl}` : 'Last form URL: unknown',
    row.latestAttemptReason ? `Latest attempt reason: ${row.latestAttemptReason}` : ''
  ].filter(Boolean).join('\n');
}

function buildWorkflowStepStates(brand, { hasIngestedMessage = false } = {}) {
  const status = String(brand.onboardingStatus || '');
  const failed = status === 'failed' || status === 'captcha_blocked';
  const active = status === 'active';
  const signupAttempted = Number(brand.signupAttempts || 0) > 0 || !!brand.lastSignupAttempt;
  const submittedStates = new Set(['submitted', 'subscribing', 'awaiting_confirmation', 'confirmed', 'active']);
  const confirmationSeen = !!brand.signupConfirmedAt || status === 'confirmed';
  const newsletterSeen = !!brand.firstNewsletterAt || Number(brand.totalEmailsReceived || 0) > 0;

  const donePendingFailed = (done, pending = false) => {
    if (done) return 'done';
    if (failed) return 'failed';
    return pending ? 'pending' : 'todo';
  };

  return {
    discovered: donePendingFailed(!!brand.discoveredAt || !!brand.createdAt, true),
    signupAttempt: donePendingFailed(signupAttempted, status === 'discovered'),
    signupSubmitted: donePendingFailed(submittedStates.has(status) || signupAttempted, signupAttempted && !submittedStates.has(status)),
    welcomeEmail: donePendingFailed(!!brand.welcomeEmailReceived, status === 'awaiting_confirmation' || status === 'submitted' || status === 'subscribing'),
    confirmation: donePendingFailed(confirmationSeen, !!brand.confirmationRequired && !confirmationSeen),
    newsletterSeen: donePendingFailed(newsletterSeen, status === 'awaiting_confirmation' || status === 'confirmed'),
    ingestion: donePendingFailed(hasIngestedMessage, newsletterSeen),
    active: active ? 'done' : (failed ? 'failed' : 'todo')
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function startWorkflowRun(step, meta = {}) {
  try {
    return await WorkflowRun.create({
      step,
      trigger: 'api',
      status: 'running',
      startedAt: new Date(),
      meta
    });
  } catch {
    return null;
  }
}

async function completeWorkflowRun(run, status, summary = null, error = null) {
  if (!run) return;
  try {
    run.status = status;
    run.summary = summary;
    run.error = error;
    run.completedAt = new Date();
    run.durationMs = Math.max(0, run.completedAt.getTime() - new Date(run.startedAt).getTime());
    await run.save();
  } catch {
    // non-fatal
  }
}

async function runStepWithTracking(step, options, meta = {}) {
  const run = await startWorkflowRun(step, meta);
  try {
    const result = await runJob(step, options || {});
    await completeWorkflowRun(run, 'success', result, null);
    return { status: 'success', result };
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    return { status: 'failed', error: err.message };
  }
}

// -- SSE Endpoint (open - proxied securely via Next.js server route) --
router.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = `${Date.now()}-${Math.random()}`;

  // Send snapshot on connect
  const init = JSON.stringify({
    type: 'init',
    running: agentRunning,
    logs: LOG_BUFFER.slice(-100),
    stats: currentStats,
    lastResult: agentLastResult
  });
  res.write(`data: ${init}\n\n`);

  const onLog = (entry) => {
    try { res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`); } catch (_) {}
  };
  agentEmitter.on('log', onLog);

  req.on('close', () => {
    agentEmitter.off('log', onLog);
  });
});

// -- Agent state ------------------------------------------------
let agentRunning    = false;
let agentLastResult = null;
let currentStats    = {};
let runStartedAt    = null;
let stopRequested   = false;

// -- All routes below require auth -----------------------------
router.use(requireApiAuth);

/**
 * POST /api/agent/run
 */
router.post('/agent/run', async (req, res) => {
  if (agentRunning) {
    return res.status(409).json({ error: 'Agent is already running', status: 'running' });
  }

  const { batchSize = 10, mode = 'full' } = req.body;
  if (batchSize < 1 || batchSize > 200) {
    return res.status(400).json({ error: 'batchSize must be between 1 and 200' });
  }

  agentRunning  = true;
  currentStats  = {};
  runStartedAt  = new Date();
  stopRequested = false;
  LOG_BUFFER.length = 0;

  pushLog({ level: 'info', phase: 'start', message: ` Agent started - mode: ${mode}, batchSize: ${batchSize}` });
  res.json({ message: 'Agent started', batchSize, mode, status: 'running' });
  const workflowStep = mode === 'full' ? 'discover_and_signup' : 'discover_and_signup';
  startWorkflowRun(workflowStep, { mode, batchSize }).then((runRow) => {
    const onProgress = (entry) => pushLog(entry);

    run({ batchSize, mode, onProgress, getStopFlag: () => stopRequested })
      .then(async result => {
        agentLastResult = { ...result, completedAt: new Date(), status: 'completed' };
        currentStats    = result;
        pushLog({ level: 'success', phase: 'done', message: '[OK] Run complete!', stats: result });
        await completeWorkflowRun(runRow, 'success', result, null);
      })
      .catch(async err => {
        agentLastResult = { error: err.message, status: 'failed', completedAt: new Date() };
        pushLog({ level: 'error', phase: 'error', message: `[ERR] Run failed: ${err.message}` });
        logger.error('Agent run failed:', err);
        await completeWorkflowRun(runRow, 'failed', null, err.message);
      })
      .finally(() => { agentRunning = false; });
  });
});

/** POST /api/agent/stop */
router.post('/agent/stop', (req, res) => {
  if (!agentRunning) return res.json({ message: 'Agent is not running' });
  stopRequested = true;
  pushLog({ level: 'warn', phase: 'stop', message: ' Stop requested - will halt after current brand' });
  res.json({ message: 'Stop signal sent' });
});

/** GET /api/agent/status */
router.get('/agent/status', (req, res) => {
  res.json({
    running:    agentRunning,
    startedAt:  runStartedAt,
    stats:      currentStats,
    lastResult: agentLastResult,
    recentLogs: LOG_BUFFER.slice(-80)
  });
});

/** GET /api/activity/logs?limit=200&source=runtime&level=info */
router.get('/activity/logs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const query = {};
    if (req.query.source) query.source = String(req.query.source);
    if (req.query.level) query.level = String(req.query.level);
    if (req.query.phase) query.phase = String(req.query.phase);
    const logs = await ActivityLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ logs, count: logs.length });
  } catch (err) {
    logger.error('Failed to fetch activity logs', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/activity/workflow-runs?limit=120&step=scan_inbox */
router.get('/activity/workflow-runs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 120), 500);
    const query = {};
    if (req.query.step) query.step = String(req.query.step);
    if (req.query.status) query.status = String(req.query.status);
    const runs = await WorkflowRun.find(query)
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
    res.json({ runs, count: runs.length });
  } catch (err) {
    logger.error('Failed to fetch workflow runs', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/runtime/playwright-status */
router.get('/runtime/playwright-status', async (req, res) => {
  try {
    const status = getPlaywrightRuntimeStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/runtime/playwright-preflight */
router.post('/runtime/playwright-preflight', async (req, res) => {
  try {
    const status = await ensurePlaywrightRuntimeReady({ autoInstall: true });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/discovery/pool/stats */
router.get('/discovery/pool/stats', async (req, res) => {
  try {
    const existingBrands = await Brand.find({}, 'domain').lean();
    const existingDomains = new Set(existingBrands.map((b) => String(b.domain || '').toLowerCase()));
    const stats = await getDiscoveryPoolStats(existingDomains);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/discovery/pool/fill */
router.post('/discovery/pool/fill', async (req, res) => {
  try {
    const targetSize = Math.max(100, Number(req.body?.targetSize || process.env.DISCOVERY_POOL_TARGET_SIZE || 1000));
    const maxCalls = Math.max(1, Number(req.body?.maxCalls || process.env.DISCOVERY_POOL_MAX_CALLS_PER_RUN || 8));
    const chunkSize = Math.max(10, Number(req.body?.chunkSize || process.env.DISCOVERY_POOL_FILL_BATCH || 100));
    const existingBrands = await Brand.find({}, 'domain').lean();
    const existingDomains = new Set(existingBrands.map((b) => String(b.domain || '').toLowerCase()));
    const result = await fillDiscoveryPool({ targetSize, existingDomains, maxCalls, chunkSize });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/activity/newsletters?limit=40 */
router.get('/activity/newsletters', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 40), 200);
    const messages = await EmailMessage.find({
      state: 'ingested',
      emailType: { $in: ['welcome', 'newsletter'] }
    })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .lean();

    const brandIds = [...new Set(messages.map((m) => String(m.brandId || '')).filter(Boolean))];
    const brands = await Brand.find({ _id: { $in: brandIds } }, { name: 1, domain: 1 }).lean();
    const brandMap = new Map(brands.map((b) => [String(b._id), b]));

    const rows = messages.map((m) => ({
      id: String(m._id),
      gmailMessageId: m.gmailMessageId,
      emailType: m.emailType,
      subject: m.subject || '',
      fromEmail: m.fromEmail || '',
      receivedAt: m.receivedAt,
      screenshotPath: m.screenshotPath || null,
      screenshotUrl: m.screenshotPath ? `/api/activity/newsletters/${m._id}/screenshot` : null,
      brand: m.brandId ? (brandMap.get(String(m.brandId)) || null) : null
    }));

    res.json({ rows, count: rows.length });
  } catch (err) {
    logger.error('Failed to fetch ingested newsletters', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/activity/newsletters/:id/screenshot */
router.get('/activity/newsletters/:id/screenshot', async (req, res) => {
  try {
    const message = await EmailMessage.findById(req.params.id).select('screenshotPath').lean();
    if (!message?.screenshotPath) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }
    const filePath = path.resolve(message.screenshotPath);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Screenshot file missing on server' });
    }
    res.setHeader('Cache-Control', 'private, max-age=120');
    return res.sendFile(filePath);
  } catch (err) {
    logger.error('Failed to load screenshot', err);
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/scan-emails */
router.post('/agent/scan-emails', async (req, res) => {
  const { hours = 24 } = req.body;
  try {
    const result = await scanRecentEmails(hours);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/process-inbox */
router.post('/agent/process-inbox', async (req, res) => {
  const run = await startWorkflowRun('scan_inbox', { body: req.body || {} });
  try {
    const { hours = 24, maxResults = 0 } = req.body || {};
    const result = await processInbox({ hours, maxResults });
    await completeWorkflowRun(run, 'success', result, null);
    res.json({ success: true, ...result });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/process-confirmations */
router.post('/agent/process-confirmations', async (req, res) => {
  const run = await startWorkflowRun('process_confirmations', { body: req.body || {} });
  try {
    const { limit = 50 } = req.body || {};
    const result = await processPendingConfirmations({ limit });
    await completeWorkflowRun(run, 'success', result, null);
    res.json({ success: true, ...result });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/ingest-newsletters */
router.post('/agent/ingest-newsletters', async (req, res) => {
  const run = await startWorkflowRun('ingest_newsletters', { body: req.body || {} });
  try {
    const { limit = 50 } = req.body || {};
    const result = await ingestPendingNewsletters({ limit });
    await completeWorkflowRun(run, 'success', result, null);
    res.json({ success: true, ...result });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/run-simplified-cycle */
router.post('/agent/run-simplified-cycle', async (req, res) => {
  const options = req.body || {};
  const run = await startWorkflowRun('run_simplified_cycle', { body: options });
  try {
    const startedAt = new Date().toISOString();
    const discover_and_signup = await runStepWithTracking('discover_and_signup', options, { source: 'run_simplified_cycle' });
    const recover_failed_signups = await runStepWithTracking('recover_failed_signups', options, { source: 'run_simplified_cycle' });
    const scan_inbox = await runStepWithTracking('scan_inbox', options, { source: 'run_simplified_cycle' });
    const process_confirmations = await runStepWithTracking('process_confirmations', options, { source: 'run_simplified_cycle' });
    const ingest_newsletters = await runStepWithTracking('ingest_newsletters', options, { source: 'run_simplified_cycle' });
    const retry_missing_screenshots = await runStepWithTracking('retry_missing_screenshots', options, { source: 'run_simplified_cycle' });

    const result = {
      startedAt,
      discover_and_signup,
      recover_failed_signups,
      scan_inbox,
      process_confirmations,
      ingest_newsletters,
      retry_missing_screenshots,
      completedAt: new Date().toISOString()
    };

    const hasFailure = [discover_and_signup, recover_failed_signups, scan_inbox, process_confirmations, ingest_newsletters, retry_missing_screenshots]
      .some((s) => s.status !== 'success');
    await completeWorkflowRun(run, hasFailure ? 'failed' : 'success', result, hasFailure ? 'One or more steps failed' : null);
    res.status(hasFailure ? 207 : 200).json({ success: !hasFailure, ...result });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/recover-failed-signups */
router.post('/agent/recover-failed-signups', async (req, res) => {
  const run = await startWorkflowRun('recover_failed_signups', { body: req.body || {} });
  try {
    const result = await runJob('recover_failed_signups', req.body || {});
    await completeWorkflowRun(run, 'success', result, null);
    return res.json({ success: true, ...result });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/run-agentic-cycle */
router.post('/agent/run-agentic-cycle', async (req, res) => {
  const options = req.body || {};
  const run = await startWorkflowRun('run_agentic_cycle', { body: options });
  try {
    const result = await runAgenticCycle(options, {
      trigger: 'api',
      onEvent: (event) => pushAgenticEvent(event?.runId, event)
    });
    const autoEval = req.body?.autoEval !== false;
    let evalResult = null;
    if (autoEval && result?.runId) {
      try {
        evalResult = await runEvalForAgentRun({ runId: result.runId });
      } catch (_) {
        evalResult = null;
      }
    }
    const hasFailure = result.status === 'failed';
    await completeWorkflowRun(run, hasFailure ? 'failed' : 'success', result, hasFailure ? 'agentic_cycle_failed' : null);
    return res.status(hasFailure ? 500 : (result.status === 'partial' ? 207 : 200)).json({ success: !hasFailure, ...result, eval: evalResult });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/approve-agentic-run */
router.post('/agent/approve-agentic-run', async (req, res) => {
  const runId = String(req.body?.runId || '').trim();
  if (!runId) return res.status(400).json({ error: 'runId is required' });
  try {
    const run = await approveAgenticRun(runId, req.body?.approvedBy || 'api_user');
    pushAgenticEvent(runId, {
      type: 'approval_granted',
      runId,
      approvedBy: req.body?.approvedBy || 'api_user'
    });
    return res.json({ success: true, run });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/resume-agentic-cycle */
router.post('/agent/resume-agentic-cycle', async (req, res) => {
  const runId = String(req.body?.runId || '').trim();
  if (!runId) return res.status(400).json({ error: 'runId is required' });
  const run = await startWorkflowRun('resume_agentic_cycle', { body: req.body || {} });
  try {
    const result = await resumeAgenticRun(runId, req.body || {}, {
      trigger: 'api',
      onEvent: (event) => pushAgenticEvent(event?.runId, event)
    });
    const autoEval = req.body?.autoEval !== false;
    let evalResult = null;
    if (autoEval && result?.runId) {
      try {
        evalResult = await runEvalForAgentRun({ runId: result.runId });
      } catch (_) {
        evalResult = null;
      }
    }
    const hasFailure = result.status === 'failed';
    await completeWorkflowRun(run, hasFailure ? 'failed' : 'success', result, hasFailure ? 'resume_agentic_cycle_failed' : null);
    return res.status(hasFailure ? 500 : (result.status === 'partial' ? 207 : 200)).json({ success: !hasFailure, ...result, eval: evalResult });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/agentic/runs?limit=30&status=running */
router.get('/agentic/runs', async (req, res) => {
  try {
    const runs = await listAgenticRuns({
      limit: Number(req.query.limit || 30),
      status: req.query.status ? String(req.query.status) : null
    });
    return res.json({ runs, count: runs.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/agentic/runs/:runId */
router.get('/agentic/runs/:runId', async (req, res) => {
  try {
    const run = await getAgenticRun(String(req.params.runId || '').trim());
    if (!run) return res.status(404).json({ error: 'run_not_found' });
    return res.json({ run });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/agentic/events/:runId (SSE) */
router.get('/agentic/events/:runId', (req, res) => {
  const runId = String(req.params.runId || '').trim();
  if (!runId) return res.status(400).json({ error: 'runId required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const replay = AGENTIC_EVENT_BUFFER.get(runId) || [];
  res.write(`data: ${JSON.stringify({ type: 'init', runId, events: replay.slice(-60) })}\n\n`);

  const listener = (event) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
    } catch (_) {}
  };
  agentEmitter.on(`agentic:${runId}`, listener);

  req.on('close', () => {
    agentEmitter.off(`agentic:${runId}`, listener);
  });
});

/** GET /api/agentic/observability/overview?hours=24 */
router.get('/agentic/observability/overview', async (req, res) => {
  try {
    const overview = await getAgentObservabilityOverview({
      hours: Number(req.query.hours || 24)
    });
    return res.json(overview);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/agentic/evals/run */
router.post('/agentic/evals/run', async (req, res) => {
  const runId = String(req.body?.runId || '').trim();
  if (!runId) return res.status(400).json({ error: 'runId is required' });
  try {
    const evaluation = await runEvalForAgentRun({ runId });
    return res.json({ success: true, evaluation });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/agentic/evals?limit=30&status=pass */
router.get('/agentic/evals', async (req, res) => {
  try {
    const rows = await listAgentEvals({
      limit: Number(req.query.limit || 30),
      status: req.query.status ? String(req.query.status) : null
    });
    return res.json({ evals: rows, count: rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/agentic/diagnose-and-heal */
router.post('/agentic/diagnose-and-heal', async (req, res) => {
  try {
    const result = await diagnoseAndHeal({
      runId: req.body?.runId || null,
      failedTool: req.body?.failedTool || null,
      error: req.body?.error || null
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/agent/retry-missing-screenshots */
router.post('/agent/retry-missing-screenshots', async (req, res) => {
  const run = await startWorkflowRun('retry_missing_screenshots', { body: req.body || {} });
  try {
    const { limit = 50 } = req.body || {};
    const result = await retryMissingScreenshotsForIngested({ limit });
    await completeWorkflowRun(run, 'success', result, null);
    res.json({ success: true, ...result });
  } catch (err) {
    await completeWorkflowRun(run, 'failed', null, err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- Brand CRUD -------------------------------------------------

router.get('/brands', async (req, res) => {
  try {
    const { page = 1, limit = 50, status, category, tier, minScore, search, sort = '-createdAt', stale } = req.query;
    const query = {};
    if (status)            query.onboardingStatus = status;
    if (category)          query.$or = [{ primaryCategory: category }, { categories: category }];
    if (tier)              query.brandTier = tier;
    if (stale === 'true')  query.isStale = true;
    if (stale === 'false') query.isStale = { $ne: true };
    if (minScore)          query.qualityScore = { $gte: Number(minScore) };
    if (search)            query.$text = { $search: search };

    const total  = await Brand.countDocuments(query);
    const brands = await Brand.find(query).sort(sort)
      .skip((page - 1) * limit).limit(Number(limit))
      .select('-signupAttemptLog -statusHistory -sampleEmails');

    res.json({ brands, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/brands/workflow-matrix?limit=200&page=1&status=&search= */
router.get('/brands/workflow-matrix', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(Math.max(10, Number(req.query.limit || 200)), 1000);
    const query = {};
    if (req.query.status) query.onboardingStatus = String(req.query.status);
    if (req.query.search) query.$text = { $search: String(req.query.search) };

    const total = await Brand.countDocuments(query);
    const brands = await Brand.find(query)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('name domain websiteUrl onboardingStatus discoveredAt createdAt updatedAt signupAttempts lastSignupAttempt signupError signupFailureCode signupFailureCategory welcomeEmailReceived confirmationRequired signupConfirmedAt firstNewsletterAt totalEmailsReceived')
      .lean();

    const brandIds = brands.map((brand) => brand._id);
    const ingestedByBrandRows = brandIds.length
      ? await EmailMessage.aggregate([
        {
          $match: {
            brandId: { $in: brandIds },
            emailType: { $in: ['newsletter', 'welcome'] },
            $or: [
              { ingestedAt: { $exists: true, $ne: null } },
              { state: { $in: ['ingested', 'finalized'] } },
              { 'processedBy.ingestion_runner.done': true }
            ]
          }
        },
        { $group: { _id: '$brandId', count: { $sum: 1 } } }
      ])
      : [];
    const ingestedByBrand = new Set(
      ingestedByBrandRows
        .filter((row) => row?._id)
        .map((row) => String(row._id))
    );

    const rows = brands.map((brand) => ({
      brandId: String(brand._id),
      name: brand.name || '',
      domain: brand.domain || '',
      websiteUrl: brand.websiteUrl || '',
      onboardingStatus: brand.onboardingStatus || 'discovered',
      updatedAt: brand.updatedAt || brand.createdAt || null,
      steps: buildWorkflowStepStates(brand, {
        hasIngestedMessage: ingestedByBrand.has(String(brand._id))
      })
    }));

    res.json({
      rows,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    logger.error('Failed to fetch workflow matrix', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/brands/failed-signup-queue?limit=500&days=30&format=json|csv */
router.get('/brands/failed-signup-queue', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 500), 5000);
    const days = Math.min(Number(req.query.days || 30), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const query = {
      onboardingStatus: { $in: ['failed', 'captcha_blocked'] },
      signupFailureAt: { $gte: since },
      signupFailureCategory: { $exists: true, $ne: null }
    };
    if (req.query.category) query.signupFailureCategory = String(req.query.category);
    if (req.query.code) query.signupFailureCode = String(req.query.code);

    const brands = await Brand.find(query)
      .sort({ signupFailureAt: -1, updatedAt: -1 })
      .limit(limit)
      .select('name domain websiteUrl subscriptionEmail onboardingStatus primaryCategory brandTier priceRange qualityScore affiliatePotentialScore source espProvider signupFormUrl signupError signupFailureCategory signupFailureCode signupFailureAt signupFailureScreenshotPath signupFailureDiagnostic signupAttemptLog notes affiliateSignupUrl lastSignupAttempt')
      .lean();

    const rows = brands.map((brand) => {
      const attempts = Array.isArray(brand.signupAttemptLog) ? brand.signupAttemptLog : [];
      const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
      const row = {
        brandId: String(brand._id),
        name: brand.name || '',
        domain: brand.domain || '',
        websiteUrl: brand.websiteUrl || `https://${brand.domain || ''}`,
        subscriptionEmail: brand.subscriptionEmail || '',
        onboardingStatus: brand.onboardingStatus || '',
        primaryCategory: brand.primaryCategory || '',
        brandTier: brand.brandTier || '',
        priceRange: brand.priceRange || '',
        qualityScore: brand.qualityScore ?? '',
        affiliatePotentialScore: brand.affiliatePotentialScore ?? '',
        source: brand.source || '',
        espProvider: brand.espProvider || '',
        signupFormUrl: brand.signupFormUrl || '',
        signupFailureCategory: brand.signupFailureCategory || '',
        signupFailureCode: brand.signupFailureCode || '',
        signupError: brand.signupError || '',
        signupFailureAt: brand.signupFailureAt || null,
        latestAttemptStrategy: lastAttempt?.strategy || '',
        latestAttemptReason: lastAttempt?.errorMessage || '',
        attemptSummary: compactAttemptSummary(brand),
        recommendedAction: recommendedManualAction(brand),
        affiliateSignupUrl: brand.affiliateSignupUrl || '',
        notes: brand.notes || '',
        screenshotUrl: brand.signupFailureScreenshotPath ? `/api/brands/${brand._id}/signup-failure-screenshot` : null
      };
      return { ...row, coworkPrompt: buildCoworkPrompt(row) };
    });

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const headers = [
        'brandId', 'name', 'domain', 'websiteUrl', 'subscriptionEmail',
        'onboardingStatus', 'primaryCategory', 'brandTier', 'priceRange',
        'qualityScore', 'affiliatePotentialScore', 'source', 'espProvider',
        'signupFormUrl', 'signupFailureCategory', 'signupFailureCode',
        'signupError', 'signupFailureAt', 'latestAttemptStrategy', 'latestAttemptReason',
        'attemptSummary', 'recommendedAction', 'affiliateSignupUrl', 'notes', 'screenshotUrl'
      ];
      const csv = [
        headers.join(','),
        ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=\"failed-signup-queue-${new Date().toISOString().slice(0, 10)}.csv\"`);
      return res.send(csv);
    }

    const summaryByCode = rows.reduce((acc, row) => {
      const key = `${row.signupFailureCategory || 'unknown'}:${row.signupFailureCode || 'unknown'}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      generatedAt: new Date().toISOString(),
      count: rows.length,
      filters: { limit, days, category: req.query.category || null, code: req.query.code || null },
      summaryByCode,
      rows
    });
  } catch (err) {
    logger.error('Failed to fetch failed signup queue', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/brands/stats', async (req, res) => {
  try {
    const [generalStats] = await Brand.getStats();
    const byCategory = await Brand.aggregate([
      { $group: { _id: '$primaryCategory', count: { $sum: 1 }, avgQuality: { $avg: '$qualityScore' } } },
      { $sort: { count: -1 } }
    ]);
    const byStatus = await Brand.aggregate([{ $group: { _id: '$onboardingStatus', count: { $sum: 1 } } }]);
    res.json({ general: generalStats || {}, byCategory, byStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/brands/:id/external-sender-evidence', async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id).select(
      'name domain knownSenderEmails knownSenderDomains externalSenderEvidence'
    );
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const minEmailCount = Math.max(1, Number(process.env.EXTERNAL_SENDER_PROMOTION_MIN_COUNT || 3));
    const minDomainCount = Math.max(2, Number(process.env.EXTERNAL_SENDER_DOMAIN_PROMOTION_MIN_COUNT || 6));
    const allowDomainPromotion = String(process.env.ALLOW_EXTERNAL_SENDER_DOMAIN_PROMOTION || 'false').toLowerCase() === 'true';
    const knownEmails = new Set((brand.knownSenderEmails || []).map((value) => String(value).toLowerCase()));
    const knownDomains = new Set((brand.knownSenderDomains || []).map((value) => String(value).toLowerCase()));

    const rows = (brand.externalSenderEvidence || [])
      .map((row) => {
        const evidenceCount = Number(row.evidenceCount || 0);
        const strongProofCount = Number(row.linkMatchesBrandDomainCount || 0) + Number(row.listIdMatchesBrandCount || 0);
        const reviewStatus = String(row.reviewStatus || 'pending');
        const senderEmail = normalizeEmail(row.senderEmail);
        const senderDomain = String(row.senderDomain || '').toLowerCase();
        const senderApexDomain = String(row.senderApexDomain || '').toLowerCase();
        return {
          senderEmail,
          senderDomain,
          senderApexDomain,
          firstSeenAt: row.firstSeenAt || null,
          lastSeenAt: row.lastSeenAt || null,
          evidenceCount,
          linkMatchesBrandDomainCount: Number(row.linkMatchesBrandDomainCount || 0),
          listIdMatchesBrandCount: Number(row.listIdMatchesBrandCount || 0),
          highConfidenceMatchCount: Number(row.highConfidenceMatchCount || 0),
          lastMatchSource: row.lastMatchSource || null,
          lastMatchConfidence: Number(row.lastMatchConfidence || 0),
          promotedEmailAt: row.promotedEmailAt || null,
          promotedDomainAt: row.promotedDomainAt || null,
          reviewStatus,
          reviewedAt: row.reviewedAt || null,
          reviewNotes: row.reviewNotes || null,
          isKnownSenderEmail: knownEmails.has(senderEmail),
          isKnownSenderDomain: !!(senderDomain && knownDomains.has(senderDomain)) || !!(senderApexDomain && knownDomains.has(senderApexDomain)),
          eligibleForEmailPromotion: reviewStatus !== 'rejected' && evidenceCount >= minEmailCount && strongProofCount > 0,
          eligibleForDomainPromotion: allowDomainPromotion &&
            reviewStatus !== 'rejected' &&
            evidenceCount >= minDomainCount &&
            Number(row.linkMatchesBrandDomainCount || 0) >= minEmailCount
        };
      })
      .sort((a, b) => {
        if ((b.evidenceCount || 0) !== (a.evidenceCount || 0)) return (b.evidenceCount || 0) - (a.evidenceCount || 0);
        return new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime();
      });

    res.json({
      brand: {
        id: brand._id,
        name: brand.name,
        domain: brand.domain
      },
      thresholds: {
        emailPromotionMinCount: minEmailCount,
        domainPromotionMinCount: minDomainCount,
        allowDomainPromotion
      },
      count: rows.length,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/brands/:id/external-sender-evidence/promote', async (req, res) => {
  try {
    const senderEmail = normalizeEmail(req.body?.senderEmail);
    if (!senderEmail) return res.status(400).json({ error: 'senderEmail is required' });

    const promoteDomain = String(req.body?.promoteDomain || 'false').toLowerCase() === 'true';
    const force = String(req.body?.force || 'false').toLowerCase() === 'true';
    const reviewNotes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';

    const brand = await Brand.findById(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    brand.externalSenderEvidence = brand.externalSenderEvidence || [];
    const entry = brand.externalSenderEvidence.find((row) => normalizeEmail(row.senderEmail) === senderEmail);
    if (!entry) return res.status(404).json({ error: 'External sender evidence entry not found' });

    if (String(entry.reviewStatus || '').toLowerCase() === 'rejected' && !force) {
      return res.status(409).json({
        error: 'Entry is rejected; pass force=true to override',
        senderEmail
      });
    }

    const now = new Date();
    const senderDomain = String(entry.senderDomain || '').toLowerCase();
    const senderApexDomain = String(entry.senderApexDomain || '').toLowerCase();

    const knownEmails = new Set((brand.knownSenderEmails || []).map((value) => String(value).toLowerCase()));
    knownEmails.add(senderEmail);
    brand.knownSenderEmails = Array.from(knownEmails);
    entry.promotedEmailAt = entry.promotedEmailAt || now;

    const history = brand.senderEmailHistory || [];
    if (!history.find((row) => normalizeEmail(row.email) === senderEmail)) {
      history.push({ email: senderEmail, reason: 'manual', firstSeenAt: now, lastSeenAt: now });
      brand.senderEmailHistory = history;
    }

    if (promoteDomain) {
      const knownDomains = new Set((brand.knownSenderDomains || []).map((value) => String(value).toLowerCase()));
      if (senderDomain) knownDomains.add(senderDomain);
      if (senderApexDomain) knownDomains.add(senderApexDomain);
      brand.knownSenderDomains = Array.from(knownDomains);
      entry.promotedDomainAt = entry.promotedDomainAt || now;
    }

    entry.reviewStatus = 'approved';
    entry.reviewedAt = now;
    if (reviewNotes) entry.reviewNotes = reviewNotes;

    await brand.save();
    res.json({
      ok: true,
      brandId: brand._id,
      senderEmail,
      promoteDomain,
      row: entry
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/brands/:id/external-sender-evidence/reject', async (req, res) => {
  try {
    const senderEmail = normalizeEmail(req.body?.senderEmail);
    if (!senderEmail) return res.status(400).json({ error: 'senderEmail is required' });

    const removeExistingAlias = String(req.body?.removeExistingAlias || 'false').toLowerCase() === 'true';
    const reviewNotes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    const now = new Date();

    const brand = await Brand.findById(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    brand.externalSenderEvidence = brand.externalSenderEvidence || [];
    const entry = brand.externalSenderEvidence.find((row) => normalizeEmail(row.senderEmail) === senderEmail);
    if (!entry) return res.status(404).json({ error: 'External sender evidence entry not found' });

    entry.reviewStatus = 'rejected';
    entry.reviewedAt = now;
    if (reviewNotes) entry.reviewNotes = reviewNotes;

    if (removeExistingAlias) {
      const senderDomain = String(entry.senderDomain || '').toLowerCase();
      const senderApexDomain = String(entry.senderApexDomain || '').toLowerCase();
      brand.knownSenderEmails = (brand.knownSenderEmails || []).filter((value) => normalizeEmail(value) !== senderEmail);
      brand.knownSenderDomains = (brand.knownSenderDomains || []).filter((value) => {
        const normalized = String(value || '').toLowerCase();
        return normalized !== senderDomain && normalized !== senderApexDomain;
      });
    }

    await brand.save();
    res.json({
      ok: true,
      brandId: brand._id,
      senderEmail,
      removedExistingAlias: removeExistingAlias,
      row: entry
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json(brand);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/brands/:id/signup-failure-screenshot', async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id).select('signupFailureScreenshotPath');
    if (!brand || !brand.signupFailureScreenshotPath) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }
    const shotPath = path.resolve(brand.signupFailureScreenshotPath);
    if (!fs.existsSync(shotPath)) {
      return res.status(404).json({ error: 'Screenshot file missing on server' });
    }
    res.sendFile(shotPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/brands/:id', async (req, res) => {
  try {
    const allowedFields = ['notes','qualityScore','affiliatePotentialScore','primaryCategory',
      'categories','tags','hasAffiliateProgram','affiliateNetworks','estimatedRevShare',
      'affiliateSignupUrl','logoUrl','description','onboardingStatus','isStale'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    const brand = await Brand.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json(brand);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/brands/logo-backfill', async (req, res) => {
  try {
    const limit = Math.min(Number(req.body?.limit || 100), 1000);
    const force = String(req.body?.force || 'false').toLowerCase() === 'true';
    const query = force ? {} : { $or: [{ logoUrl: { $exists: false } }, { logoUrl: null }, { logoUrl: '' }] };

    const brands = await Brand.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select('name domain websiteUrl logoUrl')
      .lean();

    let updated = 0;
    let skipped = 0;
    const rows = [];

    for (const brand of brands) {
      const logo = await ensureBrandLogo({
        websiteUrl: brand.websiteUrl,
        domain: brand.domain,
        name: brand.name,
        currentLogoUrl: brand.logoUrl
      }, { force });

      if (logo?.ok && logo.logoUrl && logo.logoUrl !== brand.logoUrl) {
        await Brand.updateOne({ _id: brand._id }, { $set: { logoUrl: logo.logoUrl } });
        updated += 1;
        rows.push({ brand: brand.name, domain: brand.domain, logoUrl: logo.logoUrl, status: 'updated' });
      } else {
        skipped += 1;
        rows.push({ brand: brand.name, domain: brand.domain, logoUrl: brand.logoUrl || null, status: 'skipped' });
      }
    }

    return res.json({ processed: brands.length, updated, skipped, rows });
  } catch (err) {
    logger.error('Logo backfill failed', err);
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findByIdAndUpdate(req.params.id,
      { $set: { onboardingStatus: 'skipped', notes: 'Manually removed' } }, { new: true });
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Backfill screenshots endpoint
router.post('/agent/backfill-screenshots', async (req, res) => {
  try {
    const { limit = 500, withScreenshots = true, forceUpdate = true, forceScreenshotRetake = true } = req.body || {};
    res.json({ message: 'Backfill started', options: { limit, withScreenshots, forceUpdate, forceScreenshotRetake } });
    backfillListingsFromEmailMessages({ limit, withScreenshots, forceUpdate, forceScreenshotRetake }).catch(err => {
      console.error('[backfill-screenshots] error:', err.message);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/agent/retake-screenshots', async (req, res) => {
  try {
    const {
      limit = 100,
      dryRun = false,
      skipAlreadyRetaken = true,
      untilExhausted = false,
      batchSize = null,
      maxBatches = 250
    } = req.body || {};
    res.json({ message: 'Retake started', options: { limit, dryRun, skipAlreadyRetaken, untilExhausted, batchSize, maxBatches } });
    retakeListingScreenshots({ limit, dryRun, skipAlreadyRetaken, untilExhausted, batchSize, maxBatches }).catch(err => {
      console.error('[retake-screenshots] error:', err.message);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
