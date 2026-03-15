const crypto = require('crypto');
const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const AgentRun = require('../models/AgentRun');
const { buildRegistry } = require('./agentTools');
const { loadMemory, saveMemory, applyStepResult, applyIncidentLearning } = require('./agentMemory');
const { diagnoseAndHeal } = require('./agentDiagnostics');
const { createChatCompletion, getLlmConfig, isLlmAvailable } = require('./llmClient');
const logger = require('../utils/logger');

const TOOL_POLICIES = {
  discover_and_signup: { maxRetries: 1 },
  scan_inbox: { maxRetries: 2 },
  process_confirmations: { maxRetries: 2 },
  ingest_newsletters: { maxRetries: 2 },
  retry_missing_screenshots: { maxRetries: 1 },
  recover_failed_signups: { maxRetries: 1 },
  diagnose_and_heal: { maxRetries: 0 }
};

function nowIso() {
  return new Date().toISOString();
}

function compactError(err) {
  return String(err?.message || err || 'unknown_error').slice(0, 400);
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readAgenticConfig(options = {}) {
  return {
    maxPlannerSteps: Math.max(2, Number(options.maxPlannerSteps || process.env.AGENTIC_MAX_STEPS || 8)),
    stopOnFirstFailure: parseBool(options.stopOnFirstFailure ?? process.env.AGENTIC_STOP_ON_FIRST_FAILURE, false),
    useLlmPlanner: parseBool(options.useLlmPlanner ?? process.env.AGENTIC_USE_LLM_PLANNER, true),
    batchSize: Math.max(1, Number(options.batchSize || process.env.BATCH_SIZE || 10)),
    inboxHours: Math.max(1, Number(options.inboxHours || process.env.SCAN_HOURS || 24)),
    maxInboxResults: Math.max(0, Number(options.maxInboxResults || process.env.SCAN_MAX_RESULTS || 0)),
    confirmationLimit: Math.max(1, Number(options.confirmationLimit || process.env.CONFIRMATION_LIMIT || 50)),
    ingestLimit: Math.max(1, Number(options.ingestLimit || process.env.INGEST_LIMIT || 50)),
    retryMissingScreenshotsLimit: Math.max(1, Number(options.retryMissingScreenshotsLimit || process.env.RETRY_MISSING_SCREENSHOTS_LIMIT || 50)),
    recoveryLimit: Math.max(1, Number(options.recoveryLimit || process.env.SIGNUP_RECOVERY_LIMIT || 20)),
    allowedTools: Array.isArray(options.allowedTools) ? options.allowedTools.map(normalizeStepName) : null,
    blockedTools: Array.isArray(options.blockedTools) ? options.blockedTools.map(normalizeStepName) : [],
    requireApprovalFor: Array.isArray(options.requireApprovalFor)
      ? options.requireApprovalFor.map(normalizeStepName)
      : ['discover_and_signup'],
    maxToolFailures: Math.max(1, Number(options.maxToolFailures || process.env.AGENTIC_MAX_TOOL_FAILURES || 3))
    ,
    autoHealEnabled: parseBool(options.autoHealEnabled ?? process.env.AGENTIC_AUTO_HEAL_ENABLED, true)
  };
}

async function collectSystemState() {
  const [
    awaitingConfirmation,
    pendingIngestion,
    failedBrands,
    activeBrands,
    unresolvedEmails,
    confirmationQueue
  ] = await Promise.all([
    Brand.countDocuments({ onboardingStatus: 'awaiting_confirmation' }),
    EmailMessage.countDocuments({
      emailType: { $in: ['newsletter', 'welcome'] },
      'processedBy.ingestion_runner.done': { $ne: true }
    }),
    Brand.countDocuments({ onboardingStatus: { $in: ['failed', 'captcha_blocked'] } }),
    Brand.countDocuments({ onboardingStatus: 'active' }),
    EmailMessage.countDocuments({ state: 'brand_unresolved' }),
    EmailMessage.countDocuments({
      emailType: 'confirmation',
      'processedBy.confirmation_runner.done': { $ne: true }
    })
  ]);

  return {
    capturedAt: nowIso(),
    queues: {
      awaitingConfirmation,
      pendingIngestion,
      confirmationQueue,
      unresolvedEmails
    },
    health: {
      failedBrands,
      activeBrands
    }
  };
}

function normalizeStepName(step = '') {
  return String(step || '').trim().toLowerCase();
}

function fallbackPlannerDecision({ state, executed }) {
  const done = new Set(executed.map((entry) => normalizeStepName(entry.tool)));
  const q = state?.queues || {};
  const health = state?.health || {};

  if ((q.unresolvedEmails || 0) > 0 && !done.has('scan_inbox')) {
    return { tool: 'scan_inbox', rationale: 'Unresolved emails exist; refresh parsing and brand resolution first.' };
  }
  if ((q.confirmationQueue || 0) > 0 && !done.has('process_confirmations')) {
    return { tool: 'process_confirmations', rationale: 'Pending confirmation emails are waiting for click automation.' };
  }
  if ((q.pendingIngestion || 0) > 0 && !done.has('ingest_newsletters')) {
    return { tool: 'ingest_newsletters', rationale: 'Pending newsletter messages should be materialized into listings.' };
  }
  if ((health.failedBrands || 0) > 0 && !done.has('recover_failed_signups')) {
    return { tool: 'recover_failed_signups', rationale: 'Failed signup backlog exists and should be remediated automatically.' };
  }
  if (!done.has('diagnose_and_heal')) {
    return { tool: 'diagnose_and_heal', rationale: 'Run diagnostics periodically to detect regressions and harden playbooks.' };
  }
  if (!done.has('discover_and_signup')) {
    return { tool: 'discover_and_signup', rationale: 'Top of funnel is below target; discover and submit new brands.' };
  }
  if (!done.has('scan_inbox')) {
    return { tool: 'scan_inbox', rationale: 'Scan inbox after signups to pull welcome and confirmation traffic.' };
  }
  if (!done.has('process_confirmations')) {
    return { tool: 'process_confirmations', rationale: 'Process confirmation backlog after inbox sync.' };
  }
  if (!done.has('ingest_newsletters')) {
    return { tool: 'ingest_newsletters', rationale: 'Ingest parsed newsletter data and screenshots.' };
  }
  if (!done.has('retry_missing_screenshots')) {
    return { tool: 'retry_missing_screenshots', rationale: 'Run screenshot recovery pass for quality.' };
  }
  return { tool: null, rationale: 'No high-priority steps remain for this cycle.' };
}

function parsePlannerJson(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function llmPlannerDecision({ state, executed, options, memory, toolNames }) {
  if (!isLlmAvailable()) return null;
  const llmCfg = getLlmConfig();
  const prompt = [
    'You are a workflow planner for a production brand onboarding and email ingestion agent.',
    'Return strict JSON only:',
    '{"tool":"<tool name or stop>","rationale":"...","risk":"low|medium|high"}',
    '',
    `Current state: ${JSON.stringify(state)}`,
    `Executed steps this run: ${JSON.stringify(executed.map((s) => s.tool))}`,
    `Run options: ${JSON.stringify(options)}`,
    `Available tools: ${JSON.stringify(toolNames)}`,
    `Reliability memory: ${JSON.stringify(memory?.semantic?.toolReliability || {})}`,
    '',
    'Decision rules:',
    '- Prefer draining existing queues before adding new signups.',
    '- Use discover_and_signup only when ingestion/confirmation queues are manageable.',
    '- Use retry_missing_screenshots near the end.',
    '- Use stop when no meaningful work remains.'
  ].join('\n');

  const completion = await createChatCompletion({
    phase: 'agent_planner',
    maxTokens: 220,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }]
  });

  const parsed = parsePlannerJson(completion.text);
  if (!parsed || typeof parsed !== 'object') return null;
  const allowed = new Set([...toolNames, 'stop']);
  const tool = normalizeStepName(parsed.tool);
  if (!allowed.has(tool)) return null;

  return {
    tool: tool === 'stop' ? null : tool,
    rationale: String(parsed.rationale || 'Planner selected next best step').slice(0, 260),
    risk: String(parsed.risk || 'medium'),
    plannerModel: llmCfg.model
  };
}

function buildToolOptions(tool, cfg) {
  switch (tool) {
    case 'discover_and_signup':
      return { batchSize: cfg.batchSize };
    case 'scan_inbox':
      return { inboxHours: cfg.inboxHours, maxInboxResults: cfg.maxInboxResults };
    case 'process_confirmations':
      return { limit: cfg.confirmationLimit };
    case 'ingest_newsletters':
      return { limit: cfg.ingestLimit };
    case 'retry_missing_screenshots':
      return { limit: cfg.retryMissingScreenshotsLimit };
    case 'recover_failed_signups':
      return { limit: cfg.recoveryLimit };
    case 'diagnose_and_heal':
      return { runId: cfg.currentRunId || null };
    default:
      return {};
  }
}

async function executeToolWithRetry({ tool, cfg, recordStep, runDoc, tools }) {
  const policy = TOOL_POLICIES[tool] || { maxRetries: 1 };
  let attempt = 0;
  let lastError = null;

  while (attempt <= policy.maxRetries) {
    attempt += 1;
    const started = Date.now();
    const input = buildToolOptions(tool, cfg);
    try {
      const toolDef = tools[tool];
      if (!toolDef) throw new Error(`Tool not found in registry: ${tool}`);
      const output = await toolDef.execute(input);
      const durationMs = Date.now() - started;
      await recordStep({
        tool,
        status: 'success',
        attempts: attempt,
        input,
        output,
        durationMs
      });
      runDoc.metrics.toolsRun += 1;
      if (attempt > 1) runDoc.metrics.retries += (attempt - 1);
      return { ok: true, output, attempts: attempt };
    } catch (err) {
      lastError = err;
      const durationMs = Date.now() - started;
      const canRetry = attempt <= policy.maxRetries;
      await recordStep({
        tool,
        status: canRetry ? 'skipped' : 'failed',
        attempts: attempt,
        input,
        output: null,
        error: compactError(err),
        durationMs
      });
      runDoc.metrics.toolFailures += 1;
      if (!canRetry) break;
    }
  }

  return { ok: false, error: compactError(lastError), attempts: attempt };
}

function summarizeToolOutput(output) {
  if (!output || typeof output !== 'object') return { ok: true };
  const summary = {};
  const keys = ['processed', 'scanned', 'confirmed', 'failed', 'ingested', 'signupSuccess', 'signupFailed'];
  for (const key of keys) {
    if (output[key] != null) summary[key] = output[key];
  }
  if (!Object.keys(summary).length) {
    summary.keys = Object.keys(output).slice(0, 8);
  }
  return summary;
}

async function runAgenticCycle(rawOptions = {}, meta = {}) {
  const cfg = readAgenticConfig(rawOptions);
  const tools = buildRegistry();
  const allToolNames = Object.keys(tools);
  const controlledTools = allToolNames.filter((name) => {
    if (cfg.allowedTools && cfg.allowedTools.length && !cfg.allowedTools.includes(name)) return false;
    if (cfg.blockedTools.includes(name)) return false;
    return true;
  });

  const runId = `ar_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  let globalMemory = await loadMemory();
  const shortTermMemory = {
    createdAt: nowIso(),
    decisions: [],
    toolOutputs: []
  };

  const runDoc = await AgentRun.create({
    runId,
    objective: 'Autonomously execute brand onboarding and newsletter ingestion with planning + retries + memory.',
    status: 'running',
    trigger: meta.trigger || 'api',
    options: { ...cfg, sourceOptions: rawOptions || {} },
    planner: {
      provider: cfg.useLlmPlanner && isLlmAvailable() ? 'llm+heuristic_fallback' : 'heuristic',
      model: cfg.useLlmPlanner && isLlmAvailable() ? getLlmConfig().model : null,
      calls: 0
    },
    control: {
      allowedTools: controlledTools,
      blockedTools: cfg.blockedTools,
      requireApprovalFor: cfg.requireApprovalFor,
      maxSteps: cfg.maxPlannerSteps,
      maxToolFailures: cfg.maxToolFailures
    },
    approvals: {
      pending: false
    },
    memory: {
      shortTerm: shortTermMemory,
      longTerm: globalMemory
    },
    metrics: {
      toolsRun: 0,
      toolFailures: 0,
      retries: 0,
      startedAt: new Date()
    }
  });

  const executed = [];
  const onEvent = typeof meta.onEvent === 'function' ? meta.onEvent : () => {};
  cfg.currentRunId = runDoc.runId;
  onEvent({
    type: 'run_started',
    runId: runDoc.runId,
    objective: runDoc.objective,
    control: runDoc.control
  });

  const recordCheckpoint = async (phase, summary, state) => {
    runDoc.checkpoints.push({ phase, summary, state });
    runDoc.memory.shortTerm.lastCheckpoint = { phase, at: nowIso(), summary };
    await runDoc.save();
  };

  const recordStep = async (step) => {
    const sequence = runDoc.steps.length + 1;
    runDoc.steps.push({
      sequence,
      tool: step.tool,
      rationale: step.rationale || '',
      status: step.status,
      startedAt: step.startedAt || new Date(Date.now() - (step.durationMs || 0)),
      completedAt: step.completedAt || new Date(),
      durationMs: Number(step.durationMs || 0),
      attempts: Number(step.attempts || 1),
      input: step.input || null,
      output: step.output || null,
      error: step.error || null
    });
    if (step.status === 'success') {
      executed.push({ tool: step.tool, output: step.output });
      runDoc.memory.shortTerm.toolOutputs = runDoc.memory.shortTerm.toolOutputs || [];
      runDoc.memory.shortTerm.toolOutputs.push({
        at: nowIso(),
        tool: step.tool,
        summary: summarizeToolOutput(step.output)
      });
    }
    globalMemory = applyStepResult(globalMemory, {
      tool: step.tool,
      status: step.status,
      attempts: step.attempts,
      summary: summarizeToolOutput(step.output || {})
    });
    runDoc.memory.longTerm = globalMemory;
    await runDoc.save();
    onEvent({
      type: 'step_update',
      runId: runDoc.runId,
      step: {
        sequence,
        tool: step.tool,
        status: step.status,
        attempts: step.attempts
      }
    });
  };

  try {
    let stepCount = 0;
    while (stepCount < cfg.maxPlannerSteps) {
      const state = await collectSystemState();
      await recordCheckpoint('state_snapshot', `Captured state before planner step ${stepCount + 1}`, state);

      let decision = null;
      if (cfg.useLlmPlanner) {
        try {
          decision = await llmPlannerDecision({
            state,
            executed,
            options: cfg,
            memory: globalMemory,
            toolNames: controlledTools
          });
          if (decision) {
            runDoc.planner.calls += 1;
            runDoc.planner.lastDecision = decision;
            runDoc.memory.shortTerm.decisions.push({
              at: nowIso(),
              source: 'llm',
              decision
            });
            await runDoc.save();
          }
        } catch (err) {
          logger.warn(`[agentic_runtime] LLM planner failed, fallback to heuristic: ${err.message}`);
        }
      }

      if (!decision) {
        decision = fallbackPlannerDecision({ state, executed });
        runDoc.memory.shortTerm.decisions.push({
          at: nowIso(),
          source: 'heuristic',
          decision
        });
        await runDoc.save();
      }

      const selectedTool = normalizeStepName(decision.tool);
      const duplicateSelected = selectedTool && executed.find((step) => step.tool === selectedTool);
      const notAllowed = selectedTool && !controlledTools.includes(selectedTool);
      if (!selectedTool || duplicateSelected) {
        await recordCheckpoint('planner_stop', decision.rationale || 'Planner requested stop', {
          decision,
          duplicateSelected: !!duplicateSelected
        });
        break;
      }
      if (notAllowed) {
        await recordCheckpoint('planner_blocked', 'Planner selected blocked/unavailable tool', {
          selectedTool,
          allowedTools: controlledTools
        });
        break;
      }

      const requiresApproval = cfg.requireApprovalFor.includes(selectedTool);
      if (requiresApproval && !parseBool(rawOptions.autoApprove, false)) {
        runDoc.status = 'stopped';
        runDoc.approvals = {
          pending: true,
          pendingTool: selectedTool,
          requestedAt: new Date(),
          reason: `human_approval_required:${selectedTool}`
        };
        await recordCheckpoint('hitl_pause', `Paused for human approval before ${selectedTool}`, {
          selectedTool
        });
        onEvent({
          type: 'approval_required',
          runId: runDoc.runId,
          tool: selectedTool,
          rationale: decision.rationale
        });
        break;
      }

      stepCount += 1;
      const execution = await executeToolWithRetry({
        tool: selectedTool,
        cfg,
        recordStep: async (step) => recordStep({ ...step, rationale: decision.rationale }),
        runDoc,
        tools
      });

      if (!execution.ok && cfg.stopOnFirstFailure) {
        await recordCheckpoint('early_stop', `Stopping on first failure (${selectedTool})`, {
          selectedTool,
          error: execution.error
        });
        runDoc.status = 'failed';
        runDoc.error = `Tool ${selectedTool} failed: ${execution.error}`;
        break;
      }
      if (!execution.ok && cfg.autoHealEnabled) {
        try {
          const healed = await diagnoseAndHeal({
            runId: runDoc.runId,
            failedTool: selectedTool,
            error: execution.error
          });
          runDoc.checkpoints.push({
            phase: 'self_heal',
            summary: `Diagnosed ${healed.diagnosis.category} for ${selectedTool}`,
            state: healed
          });
          globalMemory = applyIncidentLearning(globalMemory, {
            category: healed.diagnosis.category,
            failedTool: selectedTool,
            actions: healed.diagnosis.actions,
            summary: healed.diagnosis.summary
          });
          runDoc.memory.longTerm = globalMemory;
          await runDoc.save();
          onEvent({
            type: 'self_heal_applied',
            runId: runDoc.runId,
            failedTool: selectedTool,
            diagnosis: healed.diagnosis,
            healing: healed.healing
          });

          if (healed.healing?.cooldownMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, healed.healing.cooldownMs));
          }
          if (healed.healing?.forceHeuristicPlanner) {
            cfg.useLlmPlanner = false;
          }
        } catch (healErr) {
          logger.warn(`[agentic_runtime] self-heal failed: ${healErr.message}`);
        }
      }
      if (Number(runDoc.metrics.toolFailures || 0) >= cfg.maxToolFailures) {
        runDoc.status = 'partial';
        await recordCheckpoint('failure_budget_exceeded', 'Stopped after crossing tool failure budget', {
          maxToolFailures: cfg.maxToolFailures,
          toolFailures: runDoc.metrics.toolFailures
        });
        break;
      }
    }

    if (runDoc.status === 'running') {
      runDoc.status = runDoc.metrics.toolFailures > 0 ? 'partial' : 'success';
    }
  } catch (err) {
    runDoc.status = 'failed';
    runDoc.error = compactError(err);
  } finally {
    runDoc.metrics.completedAt = new Date();
    runDoc.metrics.durationMs = runDoc.metrics.completedAt.getTime() - new Date(runDoc.metrics.startedAt).getTime();

    globalMemory.semantic = globalMemory.semantic || {};
    globalMemory.semantic.runStats = globalMemory.semantic.runStats || {};
    globalMemory.semantic.runStats.totalRuns = Number(globalMemory.semantic.runStats.totalRuns || 0) + 1;
    globalMemory.lastRun = {
      runId: runDoc.runId,
      status: runDoc.status,
      completedAt: nowIso(),
      toolsRun: runDoc.metrics.toolsRun,
      toolFailures: runDoc.metrics.toolFailures
    };
    runDoc.memory.longTerm = globalMemory;
    await Promise.all([runDoc.save(), saveMemory(globalMemory)]);
    onEvent({
      type: 'run_completed',
      runId: runDoc.runId,
      status: runDoc.status,
      metrics: runDoc.metrics
    });
  }

  return {
    runId: runDoc.runId,
    status: runDoc.status,
    objective: runDoc.objective,
    planner: runDoc.planner,
    metrics: runDoc.metrics,
    steps: runDoc.steps.map((step) => ({
      sequence: step.sequence,
      tool: step.tool,
      status: step.status,
      attempts: step.attempts,
      durationMs: step.durationMs,
      error: step.error || null
    })),
    checkpoints: (runDoc.checkpoints || []).slice(-5)
  };
}

async function getAgenticRun(runId) {
  return AgentRun.findOne({ runId }).lean();
}

async function approveAgenticRun(runId, approvedBy = 'api') {
  const run = await AgentRun.findOne({ runId });
  if (!run) throw new Error('run_not_found');
  if (!run.approvals?.pending) return run.toObject();
  run.approvals.pending = false;
  run.approvals.approvedAt = new Date();
  run.approvals.approvedBy = approvedBy;
  await run.save();
  return run.toObject();
}

async function resumeAgenticRun(runId, options = {}, meta = {}) {
  const run = await AgentRun.findOne({ runId }).lean();
  if (!run) throw new Error('run_not_found');
  const base = run?.options?.sourceOptions || {};
  const mergedOptions = {
    ...base,
    ...options,
    autoApprove: true
  };
  return runAgenticCycle(mergedOptions, {
    ...meta,
    trigger: meta.trigger || 'api',
    parentRunId: runId
  });
}

async function listAgenticRuns({ limit = 30, status = null } = {}) {
  const query = {};
  if (status) query.status = status;
  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 200);
  return AgentRun.find(query).sort({ createdAt: -1 }).limit(safeLimit).lean();
}

module.exports = {
  runAgenticCycle,
  getAgenticRun,
  approveAgenticRun,
  resumeAgenticRun,
  listAgenticRuns
};
