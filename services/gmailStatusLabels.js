const logger = require('../utils/logger');
const EmailMessage = require('../models/EmailMessage');
const {
  getGmailClient,
  gmailCall,
  extractSenderEmail
} = require('../config/gmail');

const DEFAULT_TARGET_EMAIL = 'victor.fire1980@gmail.com';

const ACTIVITY_CONFIG = {
  metadata_stored: {
    labelName: 'BOA/01-Metadata-Stored',
    color: { textColor: '#ffffff', backgroundColor: '#4a86e8' }
  },
  processed: {
    labelName: 'BOA/02-Processed',
    color: { textColor: '#ffffff', backgroundColor: '#fb4c2f' }
  },
  screenshot_captured: {
    labelName: 'BOA/03-Screenshot-Captured',
    color: { textColor: '#ffffff', backgroundColor: '#a479e2' }
  },
  ingested: {
    labelName: 'BOA/04-Ingested',
    color: { textColor: '#ffffff', backgroundColor: '#16a766' },
    removeActivities: ['ingestion_skipped', 'error']
  },
  ingestion_skipped: {
    labelName: 'BOA/04-Ingestion-Skipped',
    color: { textColor: '#ffffff', backgroundColor: '#ffad47' },
    removeActivities: ['ingested', 'error']
  },
  error: {
    labelName: 'BOA/05-Error',
    color: { textColor: '#ffffff', backgroundColor: '#f691b3' }
  }
};

const state = {
  loaded: false,
  byName: new Map(),
  colorSynced: new Set()
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTargetEmail() {
  return normalizeEmail(process.env.GMAIL_DEBUG_LABEL_TARGET_EMAIL || DEFAULT_TARGET_EMAIL);
}

function extractEmails(headerValue = '') {
  const value = String(headerValue || '');
  const matched = value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return Array.from(new Set(matched.map(normalizeEmail).filter(Boolean)));
}

function looksLikeRedactedRecipient(value = '') {
  const text = String(value || '');
  if (!text) return false;
  return /\[redacted[^\]]*email[^\]]*\]/i.test(text);
}

function messageTouchesTargetAddress({ parsed = null, emailMessage = null } = {}) {
  const target = readTargetEmail();
  if (!target) return false;

  const fromCandidates = new Set();
  const toCandidates = new Set();

  const parsedFrom = normalizeEmail(extractSenderEmail(parsed?.from || ''));
  if (parsedFrom) fromCandidates.add(parsedFrom);
  const messageFrom = normalizeEmail(emailMessage?.fromEmail || extractSenderEmail(emailMessage?.from || ''));
  if (messageFrom) fromCandidates.add(messageFrom);

  for (const value of extractEmails(parsed?.to || '')) toCandidates.add(value);
  for (const value of extractEmails(emailMessage?.to || '')) toCandidates.add(value);
  for (const value of extractEmails(parsed?.rawHeaders?.['delivered-to'] || '')) toCandidates.add(value);
  for (const value of extractEmails(emailMessage?.headers?.['delivered-to'] || '')) toCandidates.add(value);

  if (fromCandidates.has(target)) return true;
  if (toCandidates.has(target)) return true;

  const targetRegex = new RegExp(`\\b${escapeRegex(target)}\\b`, 'i');
  if (
    looksLikeRedactedRecipient(parsed?.to) ||
    looksLikeRedactedRecipient(emailMessage?.to) ||
    looksLikeRedactedRecipient(parsed?.rawHeaders?.['delivered-to']) ||
    looksLikeRedactedRecipient(emailMessage?.headers?.['delivered-to'])
  ) {
    return true;
  }

  return targetRegex.test(parsed?.to || '') ||
    targetRegex.test(emailMessage?.to || '') ||
    targetRegex.test(parsed?.from || '') ||
    targetRegex.test(emailMessage?.from || '');
}

async function ensureLoaded(gmail) {
  if (state.loaded) return;
  const res = await gmailCall(
    () => gmail.users.labels.list({ userId: 'me' }),
    { label: 'users.labels.list' }
  );
  const rows = res.data?.labels || [];
  for (const row of rows) {
    if (row?.name && row?.id) state.byName.set(row.name, row.id);
  }
  state.loaded = true;
}

async function ensureLabel(gmail, labelName, color) {
  await ensureLoaded(gmail);
  const existingId = state.byName.get(labelName);
  if (existingId) {
    if (!state.colorSynced.has(existingId)) {
      try {
        await gmailCall(
          () => gmail.users.labels.patch({
            userId: 'me',
            id: existingId,
            requestBody: {
              name: labelName,
              labelListVisibility: 'labelShow',
              messageListVisibility: 'show',
              color
            }
          }),
          { label: 'users.labels.patch' }
        );
        state.colorSynced.add(existingId);
      } catch (err) {
        logger.warn(`[gmail_labels] Failed to patch label "${labelName}": ${err.message}`);
      }
    }
    return existingId;
  }

  const createRes = await gmailCall(
    () => gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
        color
      }
    }),
    { label: 'users.labels.create' }
  );

  const createdId = createRes.data?.id;
  if (createdId) {
    state.byName.set(labelName, createdId);
    state.colorSynced.add(createdId);
  }
  return createdId || null;
}

async function applyActivityLabel({
  gmailMessageId,
  activities,
  parsed = null,
  emailMessage = null
}) {
  const target = readTargetEmail();
  if (!target || !gmailMessageId) return false;
  if (!messageTouchesTargetAddress({ parsed, emailMessage })) return false;

  const normalizedActivities = Array.from(new Set((activities || []).filter((activity) => ACTIVITY_CONFIG[activity])));
  if (!normalizedActivities.length) return false;

  const gmail = await getGmailClient();
  const addLabelIds = [];
  for (const activity of normalizedActivities) {
    const cfg = ACTIVITY_CONFIG[activity];
    const id = await ensureLabel(gmail, cfg.labelName, cfg.color);
    if (id) addLabelIds.push(id);
  }
  if (!addLabelIds.length) return false;

  const removeActivities = new Set();
  for (const activity of normalizedActivities) {
    const cfg = ACTIVITY_CONFIG[activity];
    for (const removeActivity of cfg.removeActivities || []) {
      removeActivities.add(removeActivity);
    }
  }

  // Keep mutually-exclusive outcome labels synchronized to DB truth.
  const outcomeActivities = ['ingested', 'ingestion_skipped', 'error'];
  for (const outcome of outcomeActivities) {
    if (!normalizedActivities.includes(outcome)) {
      removeActivities.add(outcome);
    }
  }

  const removeLabelIds = [];
  for (const activity of removeActivities) {
    const cfg = ACTIVITY_CONFIG[activity];
    if (!cfg) continue;
    const id = await ensureLabel(gmail, cfg.labelName, cfg.color);
    if (id) removeLabelIds.push(id);
  }

  await gmailCall(
    () => gmail.users.messages.modify({
      userId: 'me',
      id: String(gmailMessageId),
      requestBody: {
        addLabelIds,
        removeLabelIds: Array.from(new Set(removeLabelIds))
      }
    }),
    { label: `users.messages.modify.${normalizedActivities.join('_')}` }
  );

  return true;
}

async function markEmailActivity({
  gmailMessageId,
  activity,
  parsed = null,
  emailMessage = null
}) {
  try {
    return await applyActivityLabel({
      gmailMessageId,
      activities: [activity],
      parsed,
      emailMessage
    });
  } catch (err) {
    logger.warn(`[gmail_labels] Failed to apply activity "${activity}" for ${gmailMessageId}: ${err.message}`);
    return false;
  }
}

async function markEmailActivities({
  gmailMessageId,
  activities,
  parsed = null,
  emailMessage = null
}) {
  try {
    return await applyActivityLabel({
      gmailMessageId,
      activities,
      parsed,
      emailMessage
    });
  } catch (err) {
    logger.warn(`[gmail_labels] Failed to apply activity set "${(activities || []).join(',')}" for ${gmailMessageId}: ${err.message}`);
    return false;
  }
}

function deriveActivitiesForExistingMessage(emailMessage) {
  const activities = ['metadata_stored'];
  const state = String(emailMessage?.state || '');
  const identityState = emailMessage?.processedBy?.identity_resolver || {};
  const ingestState = emailMessage?.processedBy?.ingestion_runner || {};
  const confirmationState = emailMessage?.processedBy?.confirmation_runner || {};

  const processedStates = new Set([
    'typed',
    'brand_resolved',
    'brand_unresolved',
    'confirmation_processed',
    'ingested',
    'finalized',
    'error'
  ]);

  const hasProcessed =
    processedStates.has(state) ||
    !!identityState.done ||
    Number(identityState.attempts || 0) > 0;
  if (hasProcessed) activities.push('processed');

  if (emailMessage?.screenshotPath) activities.push('screenshot_captured');

  const ingestionDone =
    !!emailMessage?.ingestedAt ||
    ['ingested', 'finalized'].includes(state) ||
    ingestState.done === true;
  const ingestionSkipped = String(ingestState.status || '') === 'skipped';
  const hasError =
    state === 'error' ||
    String(identityState.status || '') === 'error' ||
    String(confirmationState.status || '') === 'error' ||
    String(ingestState.status || '') === 'error';

  if (ingestionDone) activities.push('ingested');
  else if (ingestionSkipped) activities.push('ingestion_skipped');

  if (hasError && !ingestionDone) activities.push('error');

  return activities;
}

async function backfillGmailLabelsForExistingEmails({
  limit = 2000,
  dryRun = false
} = {}) {
  const safeLimit = Math.max(1, Number(limit) || 2000);
  const candidates = await EmailMessage.find({
    gmailMessageId: { $exists: true, $ne: null }
  })
    .sort({ receivedAt: -1 })
    .limit(safeLimit)
    .select('gmailMessageId from fromEmail to headers state ingestedAt screenshotPath processedBy');

  const stats = {
    scanned: candidates.length,
    targetMatched: 0,
    skippedNotTarget: 0,
    dryRun: !!dryRun,
    labelOpsAttempted: 0,
    labelOpsApplied: 0,
    failed: 0
  };

  for (const message of candidates) {
    const touchesTarget = messageTouchesTargetAddress({ emailMessage: message });
    if (!touchesTarget) {
      stats.skippedNotTarget += 1;
      continue;
    }
    stats.targetMatched += 1;
    const activities = deriveActivitiesForExistingMessage(message);

    if (dryRun) {
      stats.labelOpsAttempted += activities.length;
      continue;
    }

    stats.labelOpsAttempted += activities.length;
    try {
      const applied = await markEmailActivities({
        gmailMessageId: message.gmailMessageId,
        activities,
        emailMessage: message
      });
      if (applied) stats.labelOpsApplied += activities.length;
    } catch (err) {
      stats.failed += 1;
      logger.warn(`[gmail_labels] Backfill failed for ${message.gmailMessageId}: ${err.message}`);
    }
  }

  logger.info(`[gmail_labels] Backfill completed: ${JSON.stringify(stats)}`);
  return stats;
}

async function backfillScreenshotCapturedLabelFast({
  limit = 0,
  batchSize = 500,
  dryRun = false
} = {}) {
  const target = readTargetEmail();
  if (!target) {
    throw new Error('gmail_label_target_email_missing');
  }

  const gmail = await getGmailClient();
  const screenshotCfg = ACTIVITY_CONFIG.screenshot_captured;
  const screenshotLabelId = await ensureLabel(gmail, screenshotCfg.labelName, screenshotCfg.color);
  if (!screenshotLabelId) {
    throw new Error('screenshot_label_missing');
  }

  const safeLimit = Math.max(0, Number(limit) || 0);
  const safeBatchSize = Math.max(1, Math.min(1000, Number(batchSize) || 500));
  const query = {
    gmailMessageId: { $exists: true, $ne: null },
    screenshotPath: { $exists: true, $ne: null, $ne: '' }
  };

  const candidates = safeLimit > 0
    ? await EmailMessage.find(query)
      .sort({ receivedAt: -1 })
      .limit(safeLimit)
      .select('gmailMessageId from fromEmail to headers')
      .lean()
    : await EmailMessage.find(query)
      .sort({ receivedAt: -1 })
      .select('gmailMessageId from fromEmail to headers')
      .lean();

  const ids = [];
  for (const message of candidates) {
    if (messageTouchesTargetAddress({ emailMessage: message })) {
      ids.push(String(message.gmailMessageId));
    }
  }

  const stats = {
    scanned: candidates.length,
    targetMatched: ids.length,
    dryRun: !!dryRun,
    batchSize: safeBatchSize,
    batchesAttempted: 0,
    batchesApplied: 0,
    failed: 0
  };

  if (dryRun || ids.length === 0) {
    logger.info(`[gmail_labels] Fast screenshot-label backfill dry run: ${JSON.stringify(stats)}`);
    return stats;
  }

  for (let i = 0; i < ids.length; i += safeBatchSize) {
    const chunk = ids.slice(i, i + safeBatchSize);
    stats.batchesAttempted += 1;
    try {
      await gmailCall(
        () => gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: chunk,
            addLabelIds: [screenshotLabelId]
          }
        }),
        { label: 'users.messages.batchModify.screenshot_captured' }
      );
      stats.batchesApplied += 1;
    } catch (err) {
      stats.failed += 1;
      logger.warn(`[gmail_labels] Fast screenshot-label batch failed (${chunk.length} ids): ${err.message}`);
    }
  }

  logger.info(`[gmail_labels] Fast screenshot-label backfill completed: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  markEmailActivity,
  markEmailActivities,
  messageTouchesTargetAddress,
  backfillGmailLabelsForExistingEmails,
  backfillScreenshotCapturedLabelFast
};
