# Agentic Platform Implementation

This repository now includes an agentic runtime that sits on top of your existing onboarding and email ingestion tools.

## Core Agent Primitives Added

1. Planning
- `services/agenticRuntime.js` uses an LLM planner (with heuristic fallback) to choose next tool execution.

2. Tool orchestration
- `services/agentTools.js` provides a tool registry with:
  - local production tools
  - MCP-compatible tools (configured with `AGENT_MCP_TOOLS_JSON`)

3. Memory
- Persistent semantic/episodic memory in `services/agentMemory.js` (stored in `Config`).
- Per-run memory, checkpoints, and decisions in `models/AgentRun.js`.

4. Streaming
- SSE endpoint: `GET /api/agentic/events/:runId`
- Emits run lifecycle + step updates + approval-needed events.

5. Human-in-the-loop controls
- Approval interrupt on selected tools (`requireApprovalFor`).
- API:
  - `POST /api/agent/approve-agentic-run`
  - `POST /api/agent/resume-agentic-cycle`

6. Controllability
- Per-run policy: `allowedTools`, `blockedTools`, `maxPlannerSteps`, `maxToolFailures`, approval gates.

7. Failure recovery loop (cowork replacement)
- Failures in `discover_and_signup` now enqueue `SignupRecoveryTask`.
- Recovery worker (`recover_failed_signups`) runs as a native agent tool.
- Optional MCP handoff for browser cowork automation via:
  - `SIGNUP_RECOVERY_MCP_ENDPOINT`
  - `SIGNUP_RECOVERY_MCP_TOOL`

8. Self-healing + hardening
- Runtime auto-diagnoses failed steps from logs and run traces.
- Classifies incidents (captcha/bot challenge, selector breakage, timeout/network, runtime deps, etc.).
- Applies immediate healing actions (cooldown, retry strategy changes, planner fallback, recovery tool routing).
- Persists failure-pattern learning in long-term memory so future runs self-correct faster.

## New API Surface

- `POST /api/agent/run-agentic-cycle`
- `POST /api/agent/recover-failed-signups`
- `POST /api/agent/approve-agentic-run`
- `POST /api/agent/resume-agentic-cycle`
- `GET /api/agentic/runs`
- `GET /api/agentic/runs/:runId`
- `GET /api/agentic/events/:runId` (SSE)
- `GET /api/agentic/observability/overview`
- `POST /api/agentic/evals/run`
- `GET /api/agentic/evals`
- `POST /api/agentic/diagnose-and-heal`

## New Job Commands

- `node jobs/runJob.js run_agentic_cycle`
- `node jobs/runJob.js recover_failed_signups`
- `node jobs/runJob.js resume_agentic_cycle`

## PM Interview Mapping (OpenAI/Anthropic Agent Platform)

This implementation demonstrates:

- Agent builder pain-point ownership: retries, flaky websites, blocked signups, queue backlogs.
- Infrastructure roadmap thinking: planner + tools + memory + policy controls + HITL.
- Developer product quality: explicit APIs, run observability, reproducible checkpoints.
- Enterprise readiness pattern: controllable autonomy, governance gates, and recoverability.

## Simple Explanation (Brand Agent)

1. Observability = “How is my agent doing right now?”
- We expose one overview endpoint that shows queue pressure, failures, and run reliability.
- Example for your flow: if `signupRecoveryPending` spikes, you immediately know brand signup is breaking and where to focus.

2. Evals = “Was this run good quality?”
- After an agentic run, we score it (0-100) on:
  - reliability (tool success rate)
  - backlog impact (did queues go down)
  - recovery effectiveness (did failed signups get fixed)
  - controllability (did approval and policy controls behave)
- This gives objective evidence in interviews that you measure agent quality, not just run it.

3. Streaming = “What is it doing live?”
- SSE endpoint streams step updates and approval-needed events.
- You can show live progress in UI during onboarding/ingestion.

4. Human-in-the-loop = “Pause before risky actions”
- High-risk tools (like `discover_and_signup`) can require approval.
- Run pauses, a human approves, then run resumes.

5. Persistent memory = “Agent learns from prior runs”
- Reliability stats and episodic traces are stored.
- Planner can use this to avoid weak tools and prioritize reliable paths.
