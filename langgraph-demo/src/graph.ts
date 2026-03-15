import "dotenv/config";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const AgentState = Annotation.Root({
  queueSnapshot: Annotation<Record<string, unknown>>({
    default: () => ({})
  }),
  nextTool: Annotation<string>({
    default: () => "scan_inbox"
  }),
  approvalRequired: Annotation<boolean>({
    default: () => false
  }),
  approved: Annotation<boolean>({
    default: () => false
  }),
  toolResult: Annotation<Record<string, unknown>>({
    default: () => ({})
  }),
  toolSucceeded: Annotation<boolean>({
    default: () => true
  }),
  failCount: Annotation<number>({
    default: () => 0
  }),
  diagnosis: Annotation<Record<string, unknown>>({
    default: () => ({})
  }),
  runId: Annotation<string>({
    default: () => ""
  })
});

const BASE_URL = process.env.AGENT_API_BASE_URL || "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY || "";
const APPROVAL_MODE = (process.env.APPROVAL_MODE || "manual").toLowerCase();
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";

async function apiCall(path: string, method: "GET" | "POST", body?: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${parsed?.error || text || "unknown_error"}`);
  }
  return parsed;
}

function chooseTool(queueSnapshot: Record<string, unknown>) {
  const queues = (queueSnapshot.queues || {}) as Record<string, number>;
  if ((queues.signupRecoveryPending || 0) > 0) return "recover_failed_signups";
  if ((queues.confirmationPending || 0) > 0) return "process_confirmations";
  if ((queues.ingestionPending || 0) > 0) return "ingest_newsletters";
  if ((queues.unresolvedEmails || 0) > 0) return "scan_inbox";
  return "discover_and_signup";
}

async function loadStateNode() {
  if (DRY_RUN) {
    return {
      queueSnapshot: {
        queues: {
          confirmationPending: 4,
          ingestionPending: 8,
          unresolvedEmails: 2,
          signupRecoveryPending: 1
        }
      }
    };
  }
  const queueSnapshot = await apiCall("/api/agentic/observability/overview?hours=24", "GET");
  return { queueSnapshot };
}

async function planNode(state: typeof AgentState.State) {
  const nextTool = chooseTool(state.queueSnapshot || {});
  const approvalRequired = nextTool === "discover_and_signup";
  return { nextTool, approvalRequired };
}

async function policyGateNode(state: typeof AgentState.State) {
  const blockedTools = new Set<string>();
  if (blockedTools.has(state.nextTool)) {
    return { nextTool: "scan_inbox" };
  }
  return {};
}

async function hitlGateNode(state: typeof AgentState.State) {
  if (!state.approvalRequired) return { approved: true };
  return { approved: APPROVAL_MODE === "auto" };
}

function toolRequestFor(tool: string) {
  switch (tool) {
    case "scan_inbox":
      return { path: "/api/agent/process-inbox", body: { hours: 24, maxResults: 200 } };
    case "process_confirmations":
      return { path: "/api/agent/process-confirmations", body: { limit: 50 } };
    case "ingest_newsletters":
      return { path: "/api/agent/ingest-newsletters", body: { limit: 50 } };
    case "recover_failed_signups":
      return { path: "/api/agent/recover-failed-signups", body: { limit: 20 } };
    case "retry_missing_screenshots":
      return { path: "/api/agent/retry-missing-screenshots", body: { limit: 50 } };
    case "discover_and_signup":
      return { path: "/api/agent/run", body: { batchSize: 5, mode: "full" } };
    default:
      return { path: "/api/agent/process-inbox", body: { hours: 24, maxResults: 50 } };
  }
}

async function executeToolNode(state: typeof AgentState.State) {
  try {
    const req = toolRequestFor(state.nextTool);
    const toolResult = DRY_RUN
      ? { success: true, dryRun: true, tool: state.nextTool }
      : await apiCall(req.path, "POST", req.body);
    return {
      toolResult,
      toolSucceeded: true,
      runId: String((toolResult as Record<string, unknown>)?.runId || state.runId || "")
    };
  } catch (err) {
    return {
      toolResult: { error: String((err as Error).message || err) },
      toolSucceeded: false
    };
  }
}

async function selfHealNode(state: typeof AgentState.State) {
  const error = String((state.toolResult || {})["error"] || "tool_failed");
  const diagnosis = DRY_RUN
    ? {
        diagnosis: {
          category: "timeout_or_network_instability",
          actions: ["Retry with cooldown"]
        },
        healing: { shouldRetryTool: true, cooldownMs: 2000 }
      }
    : await apiCall("/api/agentic/diagnose-and-heal", "POST", {
        runId: state.runId || null,
        failedTool: state.nextTool,
        error
      });
  return {
    diagnosis,
    failCount: state.failCount + 1
  };
}

async function persistMemoryNode(state: typeof AgentState.State) {
  return {
    toolResult: {
      ...state.toolResult,
      persistedAt: new Date().toISOString()
    }
  };
}

async function evalNode(state: typeof AgentState.State) {
  if (!state.runId || DRY_RUN) return {};
  try {
    const result = await apiCall("/api/agentic/evals/run", "POST", { runId: state.runId });
    return { toolResult: { ...state.toolResult, eval: result } };
  } catch {
    return {};
  }
}

function hitlDecision(state: typeof AgentState.State) {
  return state.approvalRequired && !state.approved ? "pause" : "continue";
}

function executionDecision(state: typeof AgentState.State) {
  return state.toolSucceeded ? "success" : "failed";
}

export const graph = new StateGraph(AgentState)
  .addNode("load_state", loadStateNode)
  .addNode("plan", planNode)
  .addNode("policy_gate", policyGateNode)
  .addNode("hitl_gate", hitlGateNode)
  .addNode("execute_tool", executeToolNode)
  .addNode("self_heal", selfHealNode)
  .addNode("persist_memory", persistMemoryNode)
  .addNode("eval", evalNode)
  .addEdge(START, "load_state")
  .addEdge("load_state", "plan")
  .addEdge("plan", "policy_gate")
  .addEdge("policy_gate", "hitl_gate")
  .addConditionalEdges("hitl_gate", hitlDecision, {
    pause: END,
    continue: "execute_tool"
  })
  .addConditionalEdges("execute_tool", executionDecision, {
    success: "persist_memory",
    failed: "self_heal"
  })
  .addEdge("self_heal", "persist_memory")
  .addEdge("persist_memory", "eval")
  .addEdge("eval", END)
  .compile();
