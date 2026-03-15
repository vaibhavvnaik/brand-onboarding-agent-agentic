# Business + Agentic Graph

```mermaid
flowchart LR
  B0["Business Goal<br/>Grow high-quality brand inventory for urklist"] --> B1["Acquire Brands"]
  B1 --> B2["Convert to Newsletter Subscribers"]
  B2 --> B3["Capture Email Content"]
  B3 --> B4["Transform to Listings"]
  B4 --> B5["Improve Reliability + Throughput"]

  subgraph AG["Agentic Control Layer"]
    A0["State + Memory<br/>short-term + persistent"]
    A1["Planner<br/>LLM + heuristic fallback"]
    A2["Policy/Control<br/>allowed tools, limits, risk gates"]
    A3["Human-in-the-loop<br/>approve/pause/resume"]
    A4["Streaming + Observability<br/>SSE + metrics APIs"]
    A5["Evals<br/>run quality scoring"]
  end

  A0 --> A1 --> A2 --> A3 --> A4 --> A5
  A5 --> A0

  subgraph TOOLS["Execution Tools"]
    T1["discover_and_signup"]
    T2["recover_failed_signups<br/>(cowork-style automated loop)"]
    T3["scan_inbox"]
    T4["process_confirmations"]
    T5["ingest_newsletters"]
    T6["retry_missing_screenshots"]
    T7["MCP tools (optional external actions)"]
  end

  A2 --> T1
  A2 --> T2
  A2 --> T3
  A2 --> T4
  A2 --> T5
  A2 --> T6
  A2 --> T7

  T1 --> B1
  T1 --> B2
  T2 --> B2
  T3 --> B3
  T4 --> B3
  T5 --> B4
  T6 --> B4
  A4 --> B5
  A5 --> B5
```

## How to read it

1. Top row is business value flow.
2. Middle row is agentic intelligence and governance.
3. Bottom row is concrete tools your runtime executes.
4. Arrows show how agentic controls drive tools, and tools drive business outcomes.
