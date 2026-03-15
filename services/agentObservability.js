const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const WorkflowRun = require('../models/WorkflowRun');
const AgentRun = require('../models/AgentRun');
const AgentEval = require('../models/AgentEval');
const SignupRecoveryTask = require('../models/SignupRecoveryTask');

async function getAgentObservabilityOverview({ hours = 24 } = {}) {
  const windowHours = Math.max(1, Number(hours || 24));
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const [
    brandStatusCounts,
    queueCounts,
    workflowRuns,
    agentRuns,
    recoveryTasks,
    recentEvals
  ] = await Promise.all([
    Brand.aggregate([{ $group: { _id: '$onboardingStatus', count: { $sum: 1 } } }]),
    Promise.all([
      EmailMessage.countDocuments({
        emailType: 'confirmation',
        'processedBy.confirmation_runner.done': { $ne: true }
      }),
      EmailMessage.countDocuments({
        emailType: { $in: ['newsletter', 'welcome'] },
        'processedBy.ingestion_runner.done': { $ne: true }
      }),
      EmailMessage.countDocuments({ state: 'brand_unresolved' }),
      SignupRecoveryTask.countDocuments({ status: 'pending' })
    ]),
    WorkflowRun.find({ startedAt: { $gte: since } }).select('step status durationMs startedAt completedAt').lean(),
    AgentRun.find({ createdAt: { $gte: since } }).select('runId status metrics planner').lean(),
    SignupRecoveryTask.find({ updatedAt: { $gte: since } }).select('status attempts resolvedAt').lean(),
    AgentEval.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(30).lean()
  ]);

  const brandByStatus = {};
  for (const row of brandStatusCounts || []) {
    brandByStatus[String(row._id || 'unknown')] = Number(row.count || 0);
  }

  const wfTotal = workflowRuns.length;
  const wfFailed = workflowRuns.filter((r) => r.status === 'failed').length;
  const wfSuccess = workflowRuns.filter((r) => r.status === 'success').length;
  const wfAvgDurationMs = wfTotal
    ? Math.round(workflowRuns.reduce((acc, row) => acc + Number(row.durationMs || 0), 0) / wfTotal)
    : 0;

  const arTotal = agentRuns.length;
  const arFailed = agentRuns.filter((r) => r.status === 'failed').length;
  const arPartial = agentRuns.filter((r) => r.status === 'partial').length;
  const arAvgDurationMs = arTotal
    ? Math.round(agentRuns.reduce((acc, row) => acc + Number(row?.metrics?.durationMs || 0), 0) / arTotal)
    : 0;

  const evalCount = recentEvals.length;
  const avgEvalScore = evalCount
    ? Math.round(recentEvals.reduce((acc, e) => acc + Number(e?.scores?.overall || 0), 0) / evalCount)
    : null;

  const recoverySummary = {
    total: recoveryTasks.length,
    resolved: recoveryTasks.filter((t) => t.status === 'resolved').length,
    failed: recoveryTasks.filter((t) => t.status === 'failed').length,
    pending: recoveryTasks.filter((t) => t.status === 'pending').length
  };

  return {
    windowHours,
    generatedAt: new Date().toISOString(),
    brands: brandByStatus,
    queues: {
      confirmationPending: queueCounts[0],
      ingestionPending: queueCounts[1],
      unresolvedEmails: queueCounts[2],
      signupRecoveryPending: queueCounts[3]
    },
    workflowRuns: {
      total: wfTotal,
      success: wfSuccess,
      failed: wfFailed,
      avgDurationMs: wfAvgDurationMs
    },
    agentRuns: {
      total: arTotal,
      failed: arFailed,
      partial: arPartial,
      avgDurationMs: arAvgDurationMs
    },
    evals: {
      count: evalCount,
      avgOverallScore: avgEvalScore
    },
    signupRecovery: recoverySummary
  };
}

module.exports = {
  getAgentObservabilityOverview
};
