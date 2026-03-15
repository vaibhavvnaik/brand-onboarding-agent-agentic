# FNL Reader Migration Runbook

This runbook migrates newsletter processing fully into `brand-onboarding-agent` without deleting existing `Listing` or association data.

## 0) Immediate Safety Actions

1. Disable `fnl_reader` GitHub Actions workflow now.
2. Keep `brand-onboarding-agent` deployed but do not enable aggressive schedules until first migration pass completes.
3. Confirm environment variables are present in runtime:
   - Mongo: `MONGODB_URI`, `URKLIST_USER_ID`
   - Gmail: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER`
   - Optional screenshots storage: `B2_KEY_ID`, `B2_APPLICATION_KEY`
   - Safety controls:
     - `BRAND_MATCH_CONFIDENCE_THRESHOLD=9` (or higher)
     - `ALLOW_EXTERNAL_SENDER_DOMAIN_PROMOTION=false`

## 1) One-Command Migration Job

Use the built-in orchestration command:

```bash
npm run job:migrate
```

It runs this sequence:
1. `scan_inbox_full_history`
2. `process_confirmations` (N passes)
3. `ingest_newsletters` (N passes)
4. `backfill_listings` (optional)

At completion it prints a JSON summary including:
- unresolved emails (`brand_unresolved`)
- pending manual-review count
- ingested/finalized email counts
- current `Listing` count

## 2) Runtime Controls (Environment Variables)

These variables tune migration behavior safely:

```bash
# Full history scan
MIGRATION_SCAN_FULL_MAX_RESULTS=0      # 0 = no cap
MIGRATION_SCAN_FULL_PAGE_SIZE=500
MIGRATION_SCAN_FULL_QUERY=             # default now uses `in:inbox`

# Confirmation + ingestion passes
MIGRATION_CONFIRMATION_PASSES=2
MIGRATION_CONFIRMATION_LIMIT=200
MIGRATION_INGESTION_PASSES=2
MIGRATION_INGESTION_LIMIT=200

# Backfill
MIGRATION_SKIP_BACKFILL=false
MIGRATION_BACKFILL_LIMIT=1000
MIGRATION_BACKFILL_WITH_SCREENSHOTS=false
MIGRATION_BACKFILL_FORCE_UPDATE=false
```

Recommended first execution (conservative):
- Set `MIGRATION_SCAN_FULL_MAX_RESULTS=2000`
- Keep `MIGRATION_BACKFILL_FORCE_UPDATE=false`
- Keep `MIGRATION_BACKFILL_WITH_SCREENSHOTS=false`

## 3) Railway Execution

From local machine with Railway CLI:

```bash
cd brand-onboarding-agent
railway run npm run job:migrate
```

Optional conservative first pass:

```bash
railway run env MIGRATION_SCAN_FULL_MAX_RESULTS=2000 MIGRATION_SKIP_BACKFILL=true npm run job:migrate
```

Optional full-inbox catch-up (recommended when older runs used `to:` filter):

```bash
railway run env MIGRATION_SCAN_FULL_QUERY="in:inbox" MIGRATION_SCAN_FULL_MAX_RESULTS=0 MIGRATION_SKIP_BACKFILL=false npm run job:migrate
```

Then full pass:

```bash
railway run env MIGRATION_SCAN_FULL_MAX_RESULTS=0 MIGRATION_SKIP_BACKFILL=false npm run job:migrate
```

## 4) Post-Run Validation

Check these conditions after migration:

1. `manual_review_queue` pending is non-zero but controlled (expected for ambiguous senders).
2. `email_messages.state=brand_unresolved` is not growing rapidly between runs.
3. New newsletters are producing `Listing` rows and screenshots (if storage enabled).
4. External sender evidence exists for ESP aliases and can be reviewed via:
   - `GET /api/brands/:id/external-sender-evidence`
   - `POST /api/brands/:id/external-sender-evidence/promote`
   - `POST /api/brands/:id/external-sender-evidence/reject`

## 5) Cutover Complete Criteria

Treat migration as complete when:
1. `fnl_reader` remains disabled.
2. Two consecutive brand-onboarding cycles run with no critical failures.
3. Manual review queue is being triaged.
4. New inbox traffic is ingested end-to-end only by `brand-onboarding-agent`.
