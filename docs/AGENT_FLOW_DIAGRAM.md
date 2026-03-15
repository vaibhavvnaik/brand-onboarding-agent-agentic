# Agent Flow Diagram

```mermaid
flowchart LR
  A["Start Agentic Run<br/>POST /api/agent/run-agentic-cycle"] --> B["Load Persistent Memory<br/>agentMemory"]
  B --> C["Capture Current State<br/>queues + health + backlog"]
  C --> D{"LLM Planner<br/>or Heuristic Fallback"}
  D --> E["Apply Control Policy<br/>allowedTools / blockedTools / maxFailures"]
  E --> F{"Approval Needed?<br/>requireApprovalFor"}
  F -->|Yes| G["Pause Run<br/>status=stopped pending_approval=true"]
  G --> H["Human Approves<br/>POST /api/agent/approve-agentic-run"]
  H --> I["Resume<br/>POST /api/agent/resume-agentic-cycle"]
  I --> C
  F -->|No| J["Execute Selected Tool"]

  J --> J1["discover_and_signup"]
  J --> J2["recover_failed_signups"]
  J --> J3["scan_inbox"]
  J --> J4["process_confirmations"]
  J --> J5["ingest_newsletters"]
  J --> J6["retry_missing_screenshots"]
  J --> J7["MCP Tools (optional)"]

  J --> K{"Tool Success?"}
  K -->|No| L["Retry by Policy<br/>TOOL_POLICIES maxRetries"]
  L --> M{"Retry Exhausted?"}
  M -->|Yes| N["Record Failure<br/>checkpoint + metrics + memory"]
  M -->|No| J
  K -->|Yes| O["Record Step Output<br/>checkpoint + metrics + memory"]
  N --> P{"Failure Budget Exceeded?"}
  O --> P
  P -->|No| C
  P -->|Yes| Q["Stop Partial/Failed"]

  C --> R{"Planner says stop<br/>or max steps hit?"}
  R -->|No| D
  R -->|Yes| S["Finalize Run<br/>status success/partial/failed"]
  Q --> S

  S --> T["Auto Eval Run Quality<br/>reliability + backlog impact + recovery + controllability"]
  T --> U["Observability APIs Update<br/>/agentic/observability/overview"]
  U --> V["Stream Events via SSE<br/>GET /api/agentic/events/:runId"]
```

## Quick Readout (Plain English)

1. Agent starts and loads memory from past runs.
2. It checks current backlog and health.
3. Planner picks the next best tool.
4. Policy gates can pause for human approval before risky tools.
5. Tool runs with retries, then results are saved.
6. Failed signup brands are automatically sent into recovery flow.
7. Loop repeats until stop condition or max steps.
8. Run gets evaluated and surfaced in observability dashboards.
