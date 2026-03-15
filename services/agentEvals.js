const crypto = require('crypto');
const AgentRun = require('../models/AgentRun');
const AgentEval = require('../models/AgentEval');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function extractQueueLoad(snapshot = {}) {
  const queues = snapshot?.queues || {};
  return Number(queues.awaitingConfirmation || 0)
    + Number(queues.pendingIngestion || 0)
    + Number(queues.confirmationQueue || 0)
    + Number(queues.unresolvedEmails || 0);
}

function scoreRun(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const checkpoints = Array.isArray(run?.checkpoints) ? run.checkpoints : [];
  const totalSteps = Math.max(1, steps.length);
  const successSteps = steps.filter((s) => s.status === 'success').length;
  const failedSteps = steps.filter((s) => s.status === 'failed').length;

  const reliability = clamp((successSteps / totalSteps) * 100, 0, 100);
  const controllability = run?.approvals?.pending ? 100 : clamp(100 - failedSteps * 10, 0, 100);

  const snapshots = checkpoints.filter((c) => c.phase === 'state_snapshot');
  const firstLoad = snapshots.length ? extractQueueLoad(snapshots[0].state) : null;
  const lastLoad = snapshots.length ? extractQueueLoad(snapshots[snapshots.length - 1].state) : null;
  let backlogImpact = 50;
  if (firstLoad != null && lastLoad != null) {
    if (firstLoad === 0 && lastLoad === 0) backlogImpact = 100;
    else if (firstLoad > 0) backlogImpact = clamp(((firstLoad - lastLoad) / firstLoad) * 100, 0, 100);
  }

  const recoveryStep = steps.find((s) => s.tool === 'recover_failed_signups' && s.status === 'success');
  let recovery = 60;
  if (recoveryStep?.output?.attempted != null) {
    const attempted = Number(recoveryStep.output.attempted || 0);
    const resolved = Number(recoveryStep.output.resolved || 0) + Number(recoveryStep.output.deferredToMcp || 0);
    recovery = attempted > 0 ? clamp((resolved / attempted) * 100, 0, 100) : 90;
  }

  const overall = clamp(
    reliability * 0.4
      + backlogImpact * 0.25
      + recovery * 0.2
      + controllability * 0.15,
    0,
    100
  );

  const findings = [];
  if (reliability < 70) findings.push('Low step reliability; multiple tool failures detected.');
  if (backlogImpact < 40) findings.push('Run did not reduce queue backlog enough.');
  if (recovery < 50) findings.push('Signup recovery effectiveness is low.');
  if (run?.approvals?.pending) findings.push('Run paused for human approval (expected in HITL mode).');
  if (!findings.length) findings.push('Run quality is healthy across reliability and queue impact.');

  const status = overall >= 80 ? 'pass' : (overall >= 55 ? 'warn' : 'fail');
  return {
    status,
    scores: {
      overall,
      reliability,
      backlogImpact,
      recovery,
      controllability
    },
    findings,
    metrics: {
      totalSteps,
      successSteps,
      failedSteps,
      firstQueueLoad: firstLoad,
      lastQueueLoad: lastLoad,
      runStatus: run?.status || 'unknown',
      durationMs: Number(run?.metrics?.durationMs || 0)
    }
  };
}

async function runEvalForAgentRun({ runId }) {
  const run = await AgentRun.findOne({ runId }).lean();
  if (!run) throw new Error('agent_run_not_found');
  const scored = scoreRun(run);
  const evalId = `ae_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const row = await AgentEval.create({
    evalId,
    runId,
    status: scored.status,
    scores: scored.scores,
    findings: scored.findings,
    metrics: scored.metrics,
    createdAtIso: new Date().toISOString()
  });
  return row.toObject();
}

async function listAgentEvals({ limit = 30, status = null } = {}) {
  const query = {};
  if (status) query.status = status;
  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 200);
  return AgentEval.find(query).sort({ createdAt: -1 }).limit(safeLimit).lean();
}

module.exports = {
  runEvalForAgentRun,
  listAgentEvals
};
