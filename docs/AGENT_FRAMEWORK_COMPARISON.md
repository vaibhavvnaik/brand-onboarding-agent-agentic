# Agent Framework Comparison (for Interview Narrative)

## What We Evaluated

1. LangGraph
- Strengths: explicit graph/state machine model, durable checkpoints, strong human-in-the-loop patterns, streaming support.
- Risks for this repo: strongest ecosystem is Python-first; adding full LangGraph stack here would mean major runtime migration from existing Node jobs.

2. Google ADK (TypeScript)
- Strengths: first-class TypeScript agent development, sessions/state, hooks/callbacks, MCP tool integration path.
- Risks for this repo: still a framework migration; we would need to re-wrap all existing services and ops controls.

3. Strands Agents
- Strengths: simple quickstart ergonomics, useful abstractions for tools + runtime hooks.
- Risks for this repo: lower adoption in this stack today vs mature custom pipeline + existing operational jobs.

4. Full custom orchestration on existing Node pipeline (chosen)
- Strengths: fastest path to production for your codebase, reuses existing hardened services, keeps deterministic control over retries and failure policies, easy to add MCP-compatible tools.
- Risks: more code ownership than framework-managed orchestration.

## Why We Chose Custom + LLM Planner + MCP Adapter

The implementation in this repo chooses a **hybrid approach**:

- Keep existing production tools (`discover_and_signup`, `scan_inbox`, `process_confirmations`, `ingest_newsletters`) intact.
- Add an LLM planner and control plane that borrows ideas from LangGraph/ADK/Strands:
  - graph-like step sequencing and checkpoints
  - streaming events
  - human approval interrupts
  - persistent memory
  - MCP-compatible tool adapters

This gives interview-grade agentic primitives without rewriting the entire product.

## Chosen Stack for This Repo

- Runtime: Node.js + Express + MongoDB
- Planner: OpenAI-compatible `/chat/completions` client (works with OpenAI-compatible backends)
- Tooling:
  - Local tool registry for current onboarding pipeline
  - MCP tool adapter via JSON-RPC `tools/call`
- Memory:
  - `AgentRun` document memory per run
  - persistent semantic/episodic memory in `Config` (`agentic_memory_v1`)
- Reliability:
  - retry policy per tool
  - failure budget and guarded stop policies
  - HITL approval gates for high-risk actions
