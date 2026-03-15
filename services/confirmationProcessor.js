const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const { clickConfirmationLinkFromParsedMessage } = require('./emailConfirmation');
const { extractSenderEmail, extractDomainFromEmail } = require('../config/gmail');
const { normalizeDomain, getRegistrableDomain } = require('../utils/domainIdentity');
const logger = require('../utils/logger');

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveBrandForMessage(message) {
  const senderEmail = extractSenderEmail(message?.from || '');
  const senderDomain = normalizeDomain(extractDomainFromEmail(senderEmail));

  if (senderEmail) {
    const byKnownSender = await Brand.findOne({
      $or: [
        { currentSenderEmail: { $regex: new RegExp(`^${escapeRegex(senderEmail)}$`, 'i') } },
        { knownSenderEmails: { $regex: new RegExp(`^${escapeRegex(senderEmail)}$`, 'i') } },
        { welcomeSenderEmails: { $regex: new RegExp(`^${escapeRegex(senderEmail)}$`, 'i') } },
        { 'senderEmailHistory.email': { $regex: new RegExp(`^${escapeRegex(senderEmail)}$`, 'i') } }
      ]
    });
    if (byKnownSender) return byKnownSender;
  }

  if (senderDomain) {
    const apex = getRegistrableDomain(senderDomain);
    const byDomain = await Brand.findOne({
      $or: [
        { domain: { $regex: new RegExp(`^${escapeRegex(senderDomain)}$`, 'i') } },
        { domain: { $regex: new RegExp(`^${escapeRegex(apex)}$`, 'i') } },
        { knownSenderDomains: { $regex: new RegExp(`^${escapeRegex(senderDomain)}$`, 'i') } },
        { knownSenderDomains: { $regex: new RegExp(`^${escapeRegex(apex)}$`, 'i') } }
      ]
    });
    if (byDomain) return byDomain;
  }

  return null;
}

async function processPendingConfirmations({ limit = 50 } = {}) {
  const candidates = await EmailMessage.find({
    emailType: 'confirmation',
    'processedBy.confirmation_runner.done': { $ne: true },
    'confirmation.retryCount': { $lt: 3 }
  }).sort({ receivedAt: -1 }).limit(limit);

  const stats = {
    scanned: candidates.length,
    attempted: 0,
    confirmed: 0,
    failed: 0,
    skipped: 0
  };

  for (const message of candidates) {
    let brand = null;
    if (message.brandId) {
      brand = await Brand.findById(message.brandId);
    }
    if (!brand) {
      brand = await resolveBrandForMessage(message);
      if (brand) {
        message.brandId = brand._id;
      }
    }

    if (!brand) {
      message.processedBy.confirmation_runner = {
        done: false,
        at: new Date(),
        version: 'v1',
        attempts: (message.processedBy?.confirmation_runner?.attempts || 0) + 1,
        status: 'error',
        lastProcessedAt: new Date(),
        error: message.brandId ? 'Brand not found' : 'Missing brandId and could not auto-resolve'
      };
      message.needsReview = true;
      await message.save();
      stats.skipped += 1;
      continue;
    }

    stats.attempted += 1;

    try {
      const parsed = {
        from: message.from,
        subject: message.subject,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        links: message.links || []
      };

      const confirmed = await clickConfirmationLinkFromParsedMessage(parsed, brand.name);
      message.confirmation = {
        required: true,
        status: confirmed ? 'confirmed' : 'failed',
        retryCount: (message.confirmation?.retryCount || 0) + 1,
        attempted: true,
        confirmed,
        clickedAt: new Date(),
        error: confirmed ? null : 'Could not verify confirmation click outcome'
      };
      message.state = 'confirmation_processed';
      message.processedBy.confirmation_runner = {
        done: true,
        at: new Date(),
        version: 'v1',
        attempts: (message.processedBy?.confirmation_runner?.attempts || 0) + 1,
        status: 'done',
        lastProcessedAt: new Date(),
        error: null
      };

      if (confirmed) {
        brand.signupConfirmedAt = new Date();
        brand.confirmationRequired = true;
        await brand.updateStatus('active', 'Async confirmation worker completed confirmation click');
        stats.confirmed += 1;
      } else {
        await brand.updateStatus('awaiting_confirmation', 'Confirmation click attempted but not verifiable');
        stats.failed += 1;
      }

      await message.save();
    } catch (err) {
      logger.warn(`[process_confirmations] ${message.gmailMessageId}: ${err.message}`);
      message.confirmation = {
        required: true,
        status: 'failed',
        retryCount: (message.confirmation?.retryCount || 0) + 1,
        attempted: true,
        confirmed: false,
        clickedAt: new Date(),
        error: err.message
      };
      message.processedBy.confirmation_runner = {
        done: false,
        at: new Date(),
        version: 'v1',
        attempts: (message.processedBy?.confirmation_runner?.attempts || 0) + 1,
        status: 'error',
        lastProcessedAt: new Date(),
        error: err.message
      };
      message.state = 'error';
      message.needsReview = true;
      await message.save();
      stats.failed += 1;
    }
  }

  logger.info(`[process_confirmations] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  processPendingConfirmations
};
