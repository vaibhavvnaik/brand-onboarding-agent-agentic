# LangGraph Demo for Brand Agent

This folder gives you a direct, interview-friendly graph view of your business + agentic flow.

## What this graph shows

1. `load_state` - reads queue health from your backend observability API
2. `plan` - selects next tool based on backlog
3. `policy_gate` - deterministic control guardrails
4. `hitl_gate` - pause if approval is required
5. `execute_tool` - runs business tool endpoint
6. `self_heal` - diagnoses failure and proposes remediation
7. `persist_memory` - stores step outcome
8. `eval` - runs quality eval for the run

## Setup

From this folder:

```bash
cd /home/vnaik/urklist/brand-onboarding-agent-agentic/langgraph-demo
cp .env.example .env
npm install
```

Edit `.env`:

- `AGENT_API_BASE_URL` = your running backend URL
- `AGENT_API_KEY` = API key for backend routes
- `APPROVAL_MODE` = `manual` or `auto`
- Optional: `DRY_RUN=true` for demo without live API calls

## Run in LangGraph Studio

Install CLI once:

```bash
pip install -U "langgraph-cli[inmem]"
```

Start Studio:

```bash
langgraph dev
```

Open the Studio URL shown in terminal.

Load graph: `brand_agent_demo` from `langgraph.json`.

## Interview walkthrough script

1. Show `load_state -> plan` as LLM/dynamic orchestration context.
2. Show `policy_gate + hitl_gate` as safety/controllability.
3. Show `execute_tool` mapping to real business actions.
4. Force a failure and show `self_heal`.
5. End at `eval` to show measurable quality.

## Mapping to your backend endpoints

- `scan_inbox` -> `POST /api/agent/process-inbox`
- `process_confirmations` -> `POST /api/agent/process-confirmations`
- `ingest_newsletters` -> `POST /api/agent/ingest-newsletters`
- `recover_failed_signups` -> `POST /api/agent/recover-failed-signups`
- `retry_missing_screenshots` -> `POST /api/agent/retry-missing-screenshots`
- `discover_and_signup` -> `POST /api/agent/run`
- diagnose/self-heal -> `POST /api/agentic/diagnose-and-heal`
- eval -> `POST /api/agentic/evals/run`
