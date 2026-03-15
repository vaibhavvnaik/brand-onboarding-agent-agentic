const ActivityLog = require('../models/ActivityLog');
const AgentRun = require('../models/AgentRun');
const logger = require('../utils/logger');

const SIGNATURES = [
  {
    category: 'captcha_or_bot_challenge',
    patterns: [/captcha/i, /cloudflare/i, /just a moment/i, /waitroom/i],
    actions: [
      'Route brand to signup recovery flow or MCP cowork browser tool.',
      'Require HITL approval before another signup attempt.',
      'Avoid immediate repeat retries for same brand/domain.'
    ],
    transient: false
  },
  {
    category: 'playwright_runtime_dependency',
    patterns: [/playwright runtime/i, /libglib/i, /chromium/i, /executable/i],
    actions: [
      'Run runtime preflight and dependency install checks.',
      'Pause signup-heavy tools until runtime status is healthy.'
    ],
    transient: false
  },
  {
    category: 'selector_or_dom_breakage',
    patterns: [/selector/i, /element not found/i, /form/i, /all strategies exhausted/i],
    actions: [
      'Trigger recover_failed_signups tool.',
      'Expand fallback strategies before marking permanent failure.'
    ],
    transient: false
  },
  {
    category: 'timeout_or_network_instability',
    patterns: [/timeout/i, /econnreset/i, /socket hang up/i, /network/i, /dns/i],
    actions: [
      'Retry with backoff and jitter.',
      'Lower concurrency and re-run failed tool once.'
    ],
    transient: true
  },
  {
    category: 'gmail_or_api_rate_limit',
    patterns: [/rate limit/i, /429/i, /quota/i, /gmail/i],
    actions: [
      'Apply cooldown before inbox/confirmation steps.',
      'Reduce scan volume for next cycle.'
    ],
    transient: true
  },
  {
    category: 'llm_planner_or_parse',
    patterns: [/llm/i, /json/i, /parse/i, /empty llm response/i],
    actions: [
      'Use heuristic planner fallback for this cycle.',
      'Log malformed planner outputs for prompt hardening.'
    ],
    transient: true
  }
];

function compact(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function classifyFailure(textBlob = '') {
  const text = String(textBlob || '');
  for (const sig of SIGNATURES) {
    if (sig.patterns.some((p) => p.test(text))) return sig;
  }
  return {
    category: 'unknown',
    actions: ['Collect more traces and escalate to HITL review.'],
    transient: false
  };
}

async function diagnoseFailureContext({ runId, failedTool, error, lookbackMinutes = 180, logLimit = 120 }) {
  const since = new Date(Date.now() - Math.max(10, Number(lookbackMinutes || 180)) * 60 * 1000);
  const [run, logs] = await Promise.all([
    runId ? AgentRun.findOne({ runId }).lean() : Promise.resolve(null),
    ActivityLog.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(Math.max(20, Number(logLimit || 120)))
      .lean()
  ]);

  const runErrors = (run?.steps || [])
    .map((step) => step?.error)
    .filter(Boolean)
    .slice(-10)
    .join(' | ');
  const logText = (logs || []).map((l) => `${l.phase || 'general'}:${l.message || ''}`).join(' | ');
  const merged = [error || '', runErrors, logText].filter(Boolean).join(' | ');
  const diagnosis = classifyFailure(merged);

  return {
    runId: runId || null,
    failedTool: failedTool || null,
    category: diagnosis.category,
    transient: !!diagnosis.transient,
    actions: diagnosis.actions,
    summary: compact(error || runErrors || 'no explicit error context'),
    evidence: {
      recentLogCount: logs.length,
      lastLogSamples: logs.slice(0, 6).map((l) => compact(`${l.phase}:${l.message}`, 180))
    }
  };
}

function chooseAutoHealActions(diagnosis = {}) {
  const category = String(diagnosis.category || 'unknown');
  const healing = {
    shouldRetryTool: false,
    cooldownMs: 0,
    forceHeuristicPlanner: false,
    recommendTool: null
  };

  if (category === 'timeout_or_network_instability' || category === 'gmail_or_api_rate_limit') {
    healing.shouldRetryTool = true;
    healing.cooldownMs = category === 'gmail_or_api_rate_limit' ? 5000 : 2000;
  }
  if (category === 'llm_planner_or_parse') {
    healing.forceHeuristicPlanner = true;
  }
  if (
    category === 'selector_or_dom_breakage'
    || category === 'captcha_or_bot_challenge'
  ) {
    healing.recommendTool = 'recover_failed_signups';
  }
  return healing;
}

async function diagnoseAndHeal(input = {}) {
  const diagnosis = await diagnoseFailureContext(input);
  const healing = chooseAutoHealActions(diagnosis);
  logger.warn(`[agent_diagnostics] category=${diagnosis.category} tool=${input.failedTool || 'unknown'} run=${input.runId || 'n/a'}`);
  return { diagnosis, healing };
}

module.exports = {
  diagnoseAndHeal,
  diagnoseFailureContext
};
