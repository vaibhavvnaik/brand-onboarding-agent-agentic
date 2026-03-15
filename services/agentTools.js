const axios = require('axios');
const { run } = require('../agents/brandOnboardingAgent');
const { processInbox } = require('./inboxProcessor');
const { processPendingConfirmations } = require('./confirmationProcessor');
const {
  ingestPendingNewsletters,
  retryMissingScreenshotsForIngested
} = require('./newsletterIngestor');
const { recoverFailedSignups } = require('./signupRecovery');
const { diagnoseAndHeal } = require('./agentDiagnostics');

function normalize(name = '') {
  return String(name || '').trim().toLowerCase();
}

function parseMcpToolsFromEnv() {
  const raw = String(process.env.AGENT_MCP_TOOLS_JSON || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && row.name && row.endpoint && row.tool);
  } catch {
    return [];
  }
}

async function callMcpTool(toolConfig, args = {}) {
  const payload = {
    jsonrpc: '2.0',
    id: `mcp_${Date.now()}`,
    method: 'tools/call',
    params: {
      name: toolConfig.tool,
      arguments: args
    }
  };
  const response = await axios.post(toolConfig.endpoint, payload, {
    timeout: Number(process.env.AGENT_MCP_TIMEOUT_MS || 15000),
    headers: { 'Content-Type': 'application/json' }
  });
  return response?.data?.result || response?.data || {};
}

function buildRegistry() {
  const localTools = {
    discover_and_signup: {
      type: 'local',
      risk: 'high',
      description: 'Discover new brands and submit newsletter signups.',
      execute: async (input) => run({
        batchSize: Number(input.batchSize || 10),
        mode: 'full',
        onProgress: () => {},
        getStopFlag: () => false
      })
    },
    scan_inbox: {
      type: 'local',
      risk: 'medium',
      description: 'Scan Gmail inbox and classify messages.',
      execute: async (input) => processInbox({
        hours: Number(input.inboxHours || 24),
        maxResults: Number(input.maxInboxResults || 0)
      })
    },
    process_confirmations: {
      type: 'local',
      risk: 'medium',
      description: 'Click and verify confirmation links.',
      execute: async (input) => processPendingConfirmations({
        limit: Number(input.limit || 50)
      })
    },
    ingest_newsletters: {
      type: 'local',
      risk: 'low',
      description: 'Ingest newsletter data into listings.',
      execute: async (input) => ingestPendingNewsletters({
        limit: Number(input.limit || 50)
      })
    },
    retry_missing_screenshots: {
      type: 'local',
      risk: 'low',
      description: 'Retry screenshot capture for quality.',
      execute: async (input) => retryMissingScreenshotsForIngested({
        limit: Number(input.limit || 50)
      })
    },
    recover_failed_signups: {
      type: 'local',
      risk: 'medium',
      description: 'Recover failed brand signups via retry or MCP cowork assist.',
      execute: async (input) => recoverFailedSignups({
        limit: Number(input.limit || 20)
      })
    },
    diagnose_and_heal: {
      type: 'local',
      risk: 'low',
      description: 'Diagnose failure patterns from logs/runs and recommend self-heal actions.',
      execute: async (input) => diagnoseAndHeal({
        runId: input.runId || null,
        failedTool: input.failedTool || null,
        error: input.error || null
      })
    }
  };

  const mcpTools = {};
  for (const mcpTool of parseMcpToolsFromEnv()) {
    const name = normalize(mcpTool.name);
    if (!name) continue;
    mcpTools[name] = {
      type: 'mcp',
      risk: String(mcpTool.risk || 'medium'),
      description: String(mcpTool.description || `MCP tool: ${mcpTool.tool}`),
      execute: async (input) => callMcpTool(mcpTool, input)
    };
  }

  return { ...localTools, ...mcpTools };
}

module.exports = {
  buildRegistry
};
