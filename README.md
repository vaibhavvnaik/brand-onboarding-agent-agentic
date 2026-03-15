# Brand Onboarding Agent

Non-blocking newsletter onboarding and ingestion pipeline for brand discovery.

## Simplified Architecture

The agent runs as short jobs and never blocks waiting for inbox events inside signup runs.

1. `discover_and_signup`
- Finds candidate brands and submits newsletter forms.
- Marks records as `awaiting_confirmation` for async handling.

2. `scan_inbox`
- Pulls recent Gmail messages, upserts by `gmailMessageId`.
- Resolves brand identity and classifies email type.

3. `process_confirmations`
- Handles only pending confirmation emails.
- Clicks confirmation links with Playwright and records retry state.

4. `ingest_newsletters`
- Saves newsletter/welcome email content and screenshot artifacts.
- Uploads screenshots to B2 (when configured) and materializes urk `Listing` records.
- Marks ingestion state in MongoDB.

## Message Lifecycle

`discovered -> parsed -> typed -> brand_resolved|brand_unresolved -> confirmation_processed -> ingested -> finalized`

Database state is the source of truth, not Gmail read/unread status.

## Local Setup

### 1) Environment

Set variables in `.env`:

- `MONGODB_URI`
- `URKLIST_USER_ID` (Mongo ObjectId for listing ownership)
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN` (or use `/setup/gmail`)
- `GMAIL_USER`
- `API_KEY`
- `B2_KEY_ID` and `B2_APPLICATION_KEY` (optional but recommended for image URLs)

Optional:

- `AGENT_API_KEY`
- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434/v1`)
- `OLLAMA_MODEL` (default: `qwen2.5:0.5b`)
- `OLLAMA_API_KEY` (optional; default: `ollama`)
- `AGENTIC_USE_LLM_PLANNER` (default: `true`)
- `AGENTIC_MAX_STEPS` (default: `8`)
- `AGENTIC_MAX_TOOL_FAILURES` (default: `3`)
- `SIGNUP_RECOVERY_LIMIT` (default: `20`)
- `SIGNUP_RECOVERY_MCP_ENDPOINT` + `SIGNUP_RECOVERY_MCP_TOOL` (optional external cowork/MCP assist)
- `AGENT_MCP_TOOLS_JSON` (optional MCP tool registry for agent runtime)

### 2) Install + checks

```bash
npm install
npm run check
```

### 3) Run jobs manually

```bash
npm run job:discover
npm run job:scan-inbox
npm run job:scan-full
npm run job:confirm
npm run job:ingest
npm run job:recover-signups
npm run job:backfill
npm run job:scrub-sensitive-content
npm run job:migrate
npm run job:cycle
npm run job:agentic-cycle
```

Migration orchestration details:
- See [docs/FNL_READER_MIGRATION_RUNBOOK.md](docs/FNL_READER_MIGRATION_RUNBOOK.md) for historical migration context
- `job:migrate` runs full-history scan + confirmation + ingestion + optional backfill in one sequence.

Full-history scan controls (env):
- `SCAN_FULL_MAX_RESULTS` default `0` (0 = no cap)
- `SCAN_FULL_PAGE_SIZE` default `500`
- `SCAN_FULL_QUERY` optional Gmail query override

Inbox scan controls (env):
- `SCAN_MAX_RESULTS` default `0` (0 = no cap; recommended for no-miss scanning)
- `SCAN_PAGE_SIZE` default `500`
- `SCAN_CURSOR_OVERLAP_SECONDS` default `300` (replay overlap to safely retry prior boundary/failure windows)
- `GMAIL_DEBUG_LABEL_TARGET_EMAIL` default `victor.fire1980@gmail.com` (only messages touching this address receive BOA status labels in Gmail)

Identity/enrichment controls (env):
- `LINK_RESOLUTION_ENABLED` default `false`
- `LINK_RESOLUTION_MAX_LINKS` default `5`
- `LINK_RESOLUTION_TIMEOUT_MS` default `5000`
- `BRAND_MATCH_CONFIDENCE_THRESHOLD` default `9` (below this goes to manual review queue)
- `EXTERNAL_SENDER_PROMOTION_MIN_COUNT` default `3`
- `ALLOW_EXTERNAL_SENDER_DOMAIN_PROMOTION` default `false`
- `EXTERNAL_SENDER_DOMAIN_PROMOTION_MIN_COUNT` default `6`

Backfill controls (env):
- `BACKFILL_LIMIT` default `500`
- `BACKFILL_WITH_SCREENSHOTS` default `false`
- `BACKFILL_FORCE_UPDATE` default `false`

Sensitive-content scrub controls (env):
- `SCRUB_SENSITIVE_DRY_RUN` default `false`
- `SCRUB_SENSITIVE_EMAIL_BATCH_SIZE` default `200`
- `SCRUB_SENSITIVE_LISTING_BATCH_SIZE` default `200`
- `SCRUB_SENSITIVE_EMAIL_LIMIT` default `0` (0 = no cap)
- `SCRUB_SENSITIVE_LISTING_LIMIT` default `0` (0 = no cap)

### 4) Run API server

```bash
npm start
```

### 5) Trigger jobs over API

```bash
curl -X POST http://localhost:3000/api/agent/process-inbox \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"hours":24,"maxResults":0}'

curl -X POST http://localhost:3000/api/agent/process-confirmations \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"limit":20}'

curl -X POST http://localhost:3000/api/agent/ingest-newsletters \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"limit":20}'

curl -X POST http://localhost:3000/api/agent/run-simplified-cycle \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"batchSize":10,"inboxHours":24,"maxInboxResults":0}'

curl -X POST http://localhost:3000/api/agent/run-agentic-cycle \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"batchSize":10,"inboxHours":24,"requireApprovalFor":["discover_and_signup"]}'

curl -X POST http://localhost:3000/api/agent/recover-failed-signups \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"limit":20}'

curl "http://localhost:3000/api/agentic/observability/overview?hours=24" \
  -H "x-api-key: $API_KEY"

curl -X POST http://localhost:3000/api/agentic/diagnose-and-heal \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"runId":"ar_123","failedTool":"discover_and_signup","error":"Timeout while waiting for selector"}'
```

Agentic architecture docs:
- `docs/AGENTIC_PLATFORM_IMPLEMENTATION.md`
- `docs/AGENT_FRAMEWORK_COMPARISON.md`

## Artifacts

Screenshots are written to `artifacts/newsletters/`.

## Production Hardening (Railway)

To permanently avoid chronic Playwright shared-library failures (for example `libglib-2.0.so.0` missing), deploy using the included `Dockerfile` instead of relying on mutable runtime installs.

- The `Dockerfile` installs Chromium and all required OS dependencies at build time via:
  - `npx playwright install --with-deps chromium`
- Runtime command stays `node boot.js`.

Recommended Railway setup:

1. Ensure Dockerfile builds are enabled for this repo/service.
2. Keep `PLAYWRIGHT_PREFLIGHT_AUTO_INSTALL=false` in production.
3. Keep exactly one scheduler instance enabled.
  - Set `INTERNAL_CRON_ENABLED=true` only on the single service that should run the scheduler.
  - Set `INTERNAL_CRON_ENABLED=false` on every other service (for example any legacy `web` service) to prevent duplicate/rogue runs.
4. After deploy, verify:
  - `GET /api/runtime/playwright-status` returns `ready: true`
  - Latest `discover_and_signup` no longer fails with runtime/preflight errors.
