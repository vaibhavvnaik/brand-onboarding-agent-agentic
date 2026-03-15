const mongoose = require('mongoose');
const EmailMessage = require('../models/EmailMessage');
const logger = require('../utils/logger');
const { scrubSensitiveContent, scrubSensitiveContentDeep } = require('../utils/contentScrubber');

function buildEmailQuery() {
  const marker = /victor\.fire1980/i;
  return {
    $or: [
      { from: marker },
      { to: marker },
      { subject: marker },
      { snippet: marker },
      { textBody: marker },
      { htmlBody: marker },
      { bodyText: marker },
      { bodyHtml: marker }
    ]
  };
}

function buildListingQuery() {
  const marker = /victor\.fire1980/i;
  return {
    $or: [
      { title: marker },
      { htmlContent: marker },
      { content: marker },
      { brandEmail: marker }
    ]
  };
}

function scrubEmailDoc(doc) {
  const updates = {};
  const assign = (field, next) => {
    if (next !== doc[field]) updates[field] = next;
  };

  assign('from', scrubSensitiveContent(doc.from || ''));
  assign('to', scrubSensitiveContent(doc.to || ''));
  assign('subject', scrubSensitiveContent(doc.subject || ''));
  assign('snippet', scrubSensitiveContent(doc.snippet || ''));
  assign('textBody', scrubSensitiveContent(doc.textBody || ''));
  assign('htmlBody', scrubSensitiveContent(doc.htmlBody || ''));
  assign('bodyText', scrubSensitiveContent(doc.bodyText || ''));
  assign('bodyHtml', scrubSensitiveContent(doc.bodyHtml || ''));

  const scrubbedHeaders = scrubSensitiveContentDeep(doc.headers || {});
  if (JSON.stringify(scrubbedHeaders) !== JSON.stringify(doc.headers || {})) {
    updates.headers = scrubbedHeaders;
  }

  return updates;
}

function scrubListingDoc(doc) {
  const updates = {};
  const assign = (field, next) => {
    if (next !== doc[field]) updates[field] = next;
  };

  assign('title', scrubSensitiveContent(doc.title || ''));
  assign('htmlContent', scrubSensitiveContent(doc.htmlContent || ''));
  assign('content', scrubSensitiveContent(doc.content || ''));
  assign('brandEmail', scrubSensitiveContent(doc.brandEmail || ''));

  return updates;
}

async function processCollectionInBatches({
  collectionName,
  query,
  projection,
  batchSize,
  cap,
  scrubDoc,
  dryRun
}) {
  const db = mongoose.connection.db;
  const col = db.collection(collectionName);

  let lastId = null;
  let scanned = 0;
  let matched = 0;
  let modified = 0;
  let batches = 0;

  while (true) {
    if (cap > 0 && scanned >= cap) break;
    const remaining = cap > 0 ? (cap - scanned) : batchSize;
    const limit = Math.max(1, Math.min(batchSize, remaining));
    const filter = lastId ? { ...query, _id: { $gt: lastId } } : query;

    const docs = await col.find(filter, { projection }).sort({ _id: 1 }).limit(limit).toArray();
    if (!docs.length) break;

    batches += 1;
    scanned += docs.length;
    matched += docs.length;
    lastId = docs[docs.length - 1]._id;

    const ops = [];
    for (const doc of docs) {
      const updates = scrubDoc(doc);
      if (!Object.keys(updates).length) continue;
      modified += 1;
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: updates }
        }
      });
    }

    if (!dryRun && ops.length) {
      await col.bulkWrite(ops, { ordered: false });
    }
  }

  return { scanned, matched, modified, batches };
}

async function runScrubSensitiveContentBackfill(options = {}) {
  const dryRun = String(options.dryRun ?? process.env.SCRUB_SENSITIVE_DRY_RUN ?? 'false').toLowerCase() === 'true';
  const emailBatchSize = Math.max(1, Number(options.emailBatchSize ?? process.env.SCRUB_SENSITIVE_EMAIL_BATCH_SIZE ?? 200));
  const listingBatchSize = Math.max(1, Number(options.listingBatchSize ?? process.env.SCRUB_SENSITIVE_LISTING_BATCH_SIZE ?? 200));
  const emailLimit = Math.max(0, Number(options.emailLimit ?? process.env.SCRUB_SENSITIVE_EMAIL_LIMIT ?? 0));
  const listingLimit = Math.max(0, Number(options.listingLimit ?? process.env.SCRUB_SENSITIVE_LISTING_LIMIT ?? 0));

  const startedAt = new Date();

  const emailMessages = await processCollectionInBatches({
    collectionName: 'email_messages',
    query: buildEmailQuery(),
    projection: {
      from: 1, to: 1, subject: 1, snippet: 1,
      textBody: 1, htmlBody: 1, bodyText: 1, bodyHtml: 1, headers: 1
    },
    batchSize: emailBatchSize,
    cap: emailLimit,
    scrubDoc: scrubEmailDoc,
    dryRun
  });

  const listings = await processCollectionInBatches({
    collectionName: 'Listing',
    query: buildListingQuery(),
    projection: {
      title: 1, htmlContent: 1, content: 1, brandEmail: 1
    },
    batchSize: listingBatchSize,
    cap: listingLimit,
    scrubDoc: scrubListingDoc,
    dryRun
  });

  const summary = {
    dryRun,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    emailMessages,
    listings
  };
  logger.info(`[scrub_sensitive_content] Completed: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { runScrubSensitiveContentBackfill };
