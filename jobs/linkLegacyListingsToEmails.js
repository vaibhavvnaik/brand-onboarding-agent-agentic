require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/database');

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 180);
}

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateDiffHours(a, b) {
  if (!a || !b) return null;
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
}

function dayKey(value) {
  const d = parseDate(value);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function scoreCandidate(listing, email) {
  const listingTitle = normalizeText(listing.title || '');
  const emailSubject = normalizeText(email.subject || '');
  const listingSlug = slugifyText(listing.title || listing.slugifyTitle || '');
  const emailSlug = slugifyText(email.subject || '');

  const listingFrom = String(listing.brandEmail || '').toLowerCase();
  const listingFromDomain = listingFrom.includes('@') ? listingFrom.split('@').pop() : '';
  const emailFrom = String(email.fromEmail || '').toLowerCase();
  const emailFromDomain = String(email.fromDomain || '').toLowerCase();

  const listingAt = parseDate(listing.receivedAt || listing.createdAt || listing.updatedAt);
  const emailAt = parseDate(email.receivedAt || email.createdAt || email.updatedAt);
  const diffHours = dateDiffHours(listingAt, emailAt);

  let score = 0;
  const reasons = [];

  if (listingTitle && emailSubject && listingTitle === emailSubject) {
    score += 0.7;
    reasons.push('subject_exact');
  } else if (listingSlug && emailSlug && listingSlug === emailSlug) {
    score += 0.6;
    reasons.push('subject_slug_exact');
  } else if (listingTitle && emailSubject && emailSubject.includes(listingTitle)) {
    score += 0.4;
    reasons.push('subject_contains');
  }

  if (listingFrom && emailFrom && listingFrom === emailFrom) {
    score += 0.2;
    reasons.push('from_email_exact');
  } else if (listingFromDomain && emailFromDomain && listingFromDomain === emailFromDomain) {
    score += 0.12;
    reasons.push('from_domain_exact');
  }

  if (diffHours !== null) {
    if (diffHours <= 1) {
      score += 0.15;
      reasons.push('time_within_1h');
    } else if (diffHours <= 24) {
      score += 0.1;
      reasons.push('time_within_24h');
    } else if (diffHours <= 72) {
      score += 0.05;
      reasons.push('time_within_72h');
    }
  }

  if (dayKey(listingAt) && dayKey(emailAt) && dayKey(listingAt) === dayKey(emailAt)) {
    score += 0.05;
    reasons.push('same_day');
  }

  return {
    score: Math.min(1, Number(score.toFixed(3))),
    reasons
  };
}

async function queueManualReview({ queueCol, listing, candidates }) {
  const now = new Date();
  const listingId = String(listing._id);
  const top = candidates.slice(0, 5).map((c) => ({
    gmailMessageId: c.gmailMessageId,
    subject: c.subject || null,
    fromEmail: c.fromEmail || null,
    fromDomain: c.fromDomain || null,
    receivedAt: c.receivedAt || null,
    confidence: c.confidence,
    reasons: c.reasons
  }));

  await queueCol.updateOne(
    { type: 'listing_email_link', listingId, status: 'pending' },
    {
      $setOnInsert: {
        createdAt: now
      },
      $set: {
        type: 'listing_email_link',
        status: 'pending',
        listingId,
        listingTitle: listing.title || null,
        listingBrandEmail: listing.brandEmail || null,
        listingReceivedAt: listing.receivedAt || null,
        candidates: top,
        updatedAt: now
      }
    },
    { upsert: true }
  );
}

async function runLinkLegacyListingsToEmails(options = {}) {
  const cfg = {
    limit: Math.max(1, toInt(options.limit ?? process.env.LINK_LEGACY_LIMIT, 500)),
    autoThreshold: Math.max(0, Math.min(1, toFloat(options.autoThreshold ?? process.env.LINK_LEGACY_AUTO_THRESHOLD, 0.95))),
    minAmbiguousThreshold: Math.max(0, Math.min(1, toFloat(options.minAmbiguousThreshold ?? process.env.LINK_LEGACY_AMBIGUOUS_THRESHOLD, 0.6))),
    ambiguousGap: Math.max(0, Math.min(1, toFloat(options.ambiguousGap ?? process.env.LINK_LEGACY_AMBIGUOUS_GAP, 0.15))),
    dryRun: toBool(options.dryRun ?? process.env.LINK_LEGACY_DRY_RUN, false)
  };

  await connectDB();
  const db = mongoose.connection.db;
  const listingCol = db.collection('Listing');
  const emailCol = db.collection('email_messages');
  const linkCol = db.collection('listing_message_link');
  const queueCol = db.collection('manual_review_queue');

  // Forward integrity guard for new writes while preserving legacy rows.
  await listingCol.createIndex({ messageId: 1 }, { unique: true, sparse: true });
  await linkCol.createIndex({ listingId: 1 }, { unique: true });

  const listings = await listingCol.find({
    $or: [
      { messageId: { $exists: false } },
      { messageId: null },
      { messageId: '' }
    ],
    title: { $type: 'string', $ne: '' }
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(cfg.limit)
    .toArray();

  const summary = {
    scanned: listings.length,
    linked: 0,
    alreadyLinked: 0,
    conflicts: 0,
    ambiguous: 0,
    unmatched: 0,
    dryRun: cfg.dryRun,
    autoThreshold: cfg.autoThreshold
  };

  for (const listing of listings) {
    const listingAt = parseDate(listing.receivedAt || listing.createdAt || listing.updatedAt);
    const listingFrom = String(listing.brandEmail || '').toLowerCase();
    const listingFromDomain = listingFrom.includes('@') ? listingFrom.split('@').pop() : null;
    const titleNorm = normalizeText(listing.title || '');
    const titleSlug = slugifyText(listing.title || listing.slugifyTitle || '');

    const timeLower = listingAt ? new Date(listingAt.getTime() - (72 * 3600 * 1000)) : null;
    const timeUpper = listingAt ? new Date(listingAt.getTime() + (72 * 3600 * 1000)) : null;

    const filter = {
      ...(timeLower && timeUpper ? { receivedAt: { $gte: timeLower, $lte: timeUpper } } : {}),
      ...(listingFromDomain ? { fromDomain: listingFromDomain } : {})
    };

    const candidatesRaw = await emailCol.find(filter, {
      projection: { gmailMessageId: 1, subject: 1, fromEmail: 1, fromDomain: 1, receivedAt: 1, rfc822MessageId: 1 }
    }).limit(40).toArray();

    const scored = candidatesRaw
      .map((email) => {
        const { score, reasons } = scoreCandidate(listing, email);
        return {
          gmailMessageId: email.gmailMessageId,
          subject: email.subject,
          fromEmail: email.fromEmail,
          fromDomain: email.fromDomain,
          receivedAt: email.receivedAt,
          confidence: score,
          reasons
        };
      })
      .filter((c) => c.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence);

    const top = scored[0] || null;
    const second = scored[1] || null;
    const confidentEnough = !!top && top.confidence >= cfg.autoThreshold;
    const distinctEnough = !second || (top.confidence - second.confidence) >= cfg.ambiguousGap;

    if (confidentEnough && distinctEnough) {
      if (cfg.dryRun) {
        summary.linked += 1;
        continue;
      }

      await linkCol.updateOne(
        { listingId: String(listing._id) },
        {
          $set: {
            listingId: String(listing._id),
            listingTitle: listing.title || null,
            gmailMessageId: top.gmailMessageId,
            confidence: top.confidence,
            method: 'auto_scored',
            reasons: top.reasons,
            reviewStatus: 'auto_applied',
            updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      try {
        const updateRes = await listingCol.updateOne(
          { _id: listing._id, $or: [{ messageId: { $exists: false } }, { messageId: null }, { messageId: '' }] },
          {
            $set: {
              messageId: top.gmailMessageId,
              sourceEmailMessageId: top.gmailMessageId,
              linkBackfilledAt: new Date(),
              linkBackfillMethod: 'auto_scored'
            }
          }
        );

        if (updateRes.matchedCount === 0) {
          summary.alreadyLinked += 1;
          continue;
        }

        summary.linked += 1;
      } catch (err) {
        if (err && err.code === 11000) {
          summary.conflicts += 1;
          await linkCol.updateOne(
            { listingId: String(listing._id) },
            {
              $set: {
                listingId: String(listing._id),
                listingTitle: listing.title || null,
                gmailMessageId: top.gmailMessageId,
                confidence: top.confidence,
                method: 'manual_review_required',
                reasons: [...(top.reasons || []), 'duplicate_messageId_conflict'],
                reviewStatus: 'pending',
                candidateCount: scored.length,
                updatedAt: new Date()
              },
              $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
          );
          await queueManualReview({ queueCol, listing, candidates: scored });
          continue;
        }
        throw err;
      }
      continue;
    }

    const ambiguousEnough = !!top && top.confidence >= cfg.minAmbiguousThreshold;
    if (ambiguousEnough) {
      summary.ambiguous += 1;
      if (cfg.dryRun) continue;

      await linkCol.updateOne(
        { listingId: String(listing._id) },
        {
          $set: {
            listingId: String(listing._id),
            listingTitle: listing.title || null,
            gmailMessageId: top.gmailMessageId,
            confidence: top.confidence,
            method: 'manual_review_required',
            reasons: top.reasons,
            reviewStatus: 'pending',
            candidateCount: scored.length,
            updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      await queueManualReview({ queueCol, listing, candidates: scored });
      continue;
    }

    summary.unmatched += 1;
    if (cfg.dryRun) continue;
    await linkCol.updateOne(
      { listingId: String(listing._id) },
      {
        $set: {
          listingId: String(listing._id),
          listingTitle: listing.title || null,
          gmailMessageId: null,
          confidence: 0,
          method: 'unmatched',
          reasons: [],
          reviewStatus: 'unmatched',
          candidateCount: scored.length,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  }

  const post = {
    listingsWithoutMessageId: await listingCol.countDocuments({
      $or: [
        { messageId: { $exists: false } },
        { messageId: null },
        { messageId: '' }
      ]
    }),
    crosswalkRows: await linkCol.countDocuments({}),
    manualReviewPending: await queueCol.countDocuments({ type: 'listing_email_link', status: 'pending' })
  };

  const result = { ...summary, post };
  console.log(JSON.stringify({ ok: true, result }, null, 2));

  await disconnectDB();
  return result;
}

if (require.main === module) {
  runLinkLegacyListingsToEmails()
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
      try { await disconnectDB(); } catch (_) {}
      process.exit(1);
    });
}

module.exports = { runLinkLegacyListingsToEmails };
