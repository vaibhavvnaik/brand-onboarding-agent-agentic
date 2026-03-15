# Testing the simplified agent plan end-to-end

## 0) Prerequisites

Set these env vars in `.env` (or Railway):

- `MONGODB_URI`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN` (or run `/setup/gmail` flow)
- `GMAIL_USER`
- `API_KEY` (for authenticated API endpoints)
- Optional: `WAIT_FOR_CONFIRMATION_INLINE=false`

## 1) Local code checks

```bash
npm run check
```

## 2) Run each worker job manually

### A. Discover + signup (non-blocking)
```bash
npm run job:discover
```

Expected:
- Brands move to `awaiting_confirmation` (or `active` when no confirmation required).

### B. Scan inbox and upsert email messages
```bash
npm run job:scan-inbox
```

Expected:
- `email_messages` collection gets documents keyed by `gmailMessageId`.
- `emailType` and `state` are populated.

### C. Process pending confirmations
```bash
npm run job:confirm
```

Expected:
- pending confirmation emails become `confirmed`/`failed`.
- related brands move to `active` when confirmation succeeds.

### D. Ingest newsletters + screenshots
```bash
npm run job:ingest
```

Expected:
- newsletter/welcome messages get `state=ingested`.
- screenshots are written under `artifacts/newsletters/`.

## 3) Run full cycle in one command

```bash
npm run job:cycle
```

This runs all four jobs in order:
1. `discover_and_signup`
2. `scan_inbox`
3. `process_confirmations`
4. `ingest_newsletters`

## 4) API-based test (for scheduler / cron)

Start server:

```bash
npm start
```

Then call endpoints with API key:

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
```

## 5) DB verification queries (Mongo shell)

```javascript
db.email_messages.countDocuments()

db.email_messages.aggregate([
  { $group: { _id: "$emailType", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
])

db.email_messages.find(
  { state: "ingested" },
  { gmailMessageId: 1, brandName: 1, screenshotPath: 1, receivedAt: 1 }
).sort({ receivedAt: -1 }).limit(20)
```
