require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/database');
const { runJob } = require('./runJob');

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function getConfig() {
  return {
    scanFullMaxResults: toInt(process.env.MIGRATION_SCAN_FULL_MAX_RESULTS, 0),
    scanFullPageSize: toInt(process.env.MIGRATION_SCAN_FULL_PAGE_SIZE, 500),
    scanFullQuery: process.env.MIGRATION_SCAN_FULL_QUERY || null,
    confirmationPasses: Math.max(1, toInt(process.env.MIGRATION_CONFIRMATION_PASSES, 2)),
    confirmationLimit: Math.max(1, toInt(process.env.MIGRATION_CONFIRMATION_LIMIT, 200)),
    ingestionPasses: Math.max(1, toInt(process.env.MIGRATION_INGESTION_PASSES, 2)),
    ingestionLimit: Math.max(1, toInt(process.env.MIGRATION_INGESTION_LIMIT, 200)),
    runBackfill: !toBool(process.env.MIGRATION_SKIP_BACKFILL, false),
    backfillLimit: Math.max(1, toInt(process.env.MIGRATION_BACKFILL_LIMIT, 1000)),
    backfillWithScreenshots: toBool(process.env.MIGRATION_BACKFILL_WITH_SCREENSHOTS, false),
    backfillForceUpdate: toBool(process.env.MIGRATION_BACKFILL_FORCE_UPDATE, false)
  };
}

async function countIfExists(collectionName, query = {}) {
  const db = mongoose.connection.db;
  const exists = await db.listCollections({ name: collectionName }, { nameOnly: true }).toArray();
  if (!exists.length) return 0;
  return db.collection(collectionName).countDocuments(query);
}

async function runMigration() {
  const cfg = getConfig();
  const stepResults = [];
  const startedAt = new Date();

  await connectDB();

  try {
    console.log('[migration] Starting brand-onboarding-agent migration run');
    console.log('[migration] Config:', JSON.stringify(cfg, null, 2));

    const scanResult = await runJob('scan_inbox_full_history', {
      maxResults: cfg.scanFullMaxResults,
      pageSize: cfg.scanFullPageSize,
      query: cfg.scanFullQuery
    });
    stepResults.push({ step: 'scan_inbox_full_history', result: scanResult });

    for (let i = 1; i <= cfg.confirmationPasses; i += 1) {
      const result = await runJob('process_confirmations', { limit: cfg.confirmationLimit });
      stepResults.push({ step: `process_confirmations_${i}`, result });
    }

    for (let i = 1; i <= cfg.ingestionPasses; i += 1) {
      const result = await runJob('ingest_newsletters', { limit: cfg.ingestionLimit });
      stepResults.push({ step: `ingest_newsletters_${i}`, result });
    }

    if (cfg.runBackfill) {
      const backfillResult = await runJob('backfill_listings', {
        limit: cfg.backfillLimit,
        withScreenshots: cfg.backfillWithScreenshots,
        forceUpdate: cfg.backfillForceUpdate
      });
      stepResults.push({ step: 'backfill_listings', result: backfillResult });
    }

    const summary = {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      stepResults,
      postRun: {
        brandUnresolved: await countIfExists('email_messages', { state: 'brand_unresolved' }),
        manualReviewPending: await countIfExists('manual_review_queue', { status: 'pending' }),
        emailIngested: await countIfExists('email_messages', { state: 'ingested' }),
        emailFinalized: await countIfExists('email_messages', { state: 'finalized' }),
        listingCount: await countIfExists('Listing')
      }
    };

    console.log('[migration] Completed successfully');
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await disconnectDB();
  }
}

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migration] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigration };
