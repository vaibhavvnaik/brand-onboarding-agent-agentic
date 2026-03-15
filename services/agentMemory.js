const Config = require('../models/Config');

const MEMORY_KEY = 'agentic_memory_v1';

function defaultMemory() {
  return {
    updatedAt: new Date().toISOString(),
    semantic: {
      toolReliability: {},
      failurePatterns: {},
      runStats: {
        totalRuns: 0,
        totalToolCalls: 0,
        totalFailures: 0
      }
    },
    episodic: [],
    working: {}
  };
}

async function loadMemory() {
  const current = await Config.get(MEMORY_KEY).catch(() => null);
  if (!current || typeof current !== 'object') return defaultMemory();
  return {
    ...defaultMemory(),
    ...current
  };
}

async function saveMemory(memory) {
  const payload = {
    ...memory,
    updatedAt: new Date().toISOString()
  };
  await Config.set(MEMORY_KEY, payload);
  return payload;
}

function applyStepResult(memory, step) {
  const next = {
    ...memory,
    semantic: { ...(memory.semantic || {}) },
    episodic: Array.isArray(memory.episodic) ? [...memory.episodic] : [],
    working: { ...(memory.working || {}) }
  };

  next.semantic.runStats = {
    totalRuns: Number(next.semantic.runStats?.totalRuns || 0),
    totalToolCalls: Number(next.semantic.runStats?.totalToolCalls || 0) + 1,
    totalFailures: Number(next.semantic.runStats?.totalFailures || 0) + (step.status === 'failed' ? 1 : 0)
  };

  const toolReliability = { ...(next.semantic.toolReliability || {}) };
  const r = toolReliability[step.tool] || { success: 0, failed: 0 };
  if (step.status === 'success') r.success += 1;
  if (step.status === 'failed') r.failed += 1;
  toolReliability[step.tool] = r;
  next.semantic.toolReliability = toolReliability;

  next.episodic.push({
    at: new Date().toISOString(),
    tool: step.tool,
    status: step.status,
    attempts: step.attempts,
    summary: step.summary || null
  });
  if (next.episodic.length > 300) {
    next.episodic = next.episodic.slice(next.episodic.length - 300);
  }
  return next;
}

function applyIncidentLearning(memory, incident = {}) {
  const next = {
    ...memory,
    semantic: { ...(memory.semantic || {}) },
    episodic: Array.isArray(memory.episodic) ? [...memory.episodic] : [],
    working: { ...(memory.working || {}) }
  };

  const category = String(incident.category || 'unknown').trim().toLowerCase() || 'unknown';
  const patterns = { ...(next.semantic.failurePatterns || {}) };
  const current = patterns[category] || {
    count: 0,
    lastSeenAt: null,
    lastTool: null,
    topActions: []
  };

  current.count += 1;
  current.lastSeenAt = new Date().toISOString();
  current.lastTool = incident.failedTool || null;
  if (Array.isArray(incident.actions)) {
    const merged = [...(current.topActions || []), ...incident.actions.map((a) => String(a || '').trim()).filter(Boolean)];
    current.topActions = Array.from(new Set(merged)).slice(-6);
  }
  patterns[category] = current;
  next.semantic.failurePatterns = patterns;

  next.episodic.push({
    at: new Date().toISOString(),
    type: 'incident_learning',
    category,
    failedTool: incident.failedTool || null,
    summary: incident.summary || null
  });
  if (next.episodic.length > 300) {
    next.episodic = next.episodic.slice(next.episodic.length - 300);
  }
  return next;
}

module.exports = {
  loadMemory,
  saveMemory,
  applyStepResult,
  applyIncidentLearning
};
