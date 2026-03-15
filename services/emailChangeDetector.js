/**
 * Email Change Detector
 * Monitors incoming newsletters and detects when a brand has changed
 * its sender email address (common when switching ESPs or sending domains).
 */
const Brand = require('../models/Brand');
const { searchMessages, getMessage, parseMessage, extractSenderEmail, extractDomainFromEmail } = require('../config/gmail');
const { classifyEmailType } = require('./emailConfirmation');
const { normalizeDomain, getRegistrableDomain, domainsRelated } = require('../utils/domainIdentity');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Process a single incoming Gmail message and update the corresponding brand.
 * Called periodically by the agent to keep brand records fresh.
 *
 * @param {string} messageId - Gmail message ID
 * @returns {Object} { brand, emailType, senderChanged, isNewSender }
 */
async function processIncomingEmail(messageId) {
  const msg     = await getMessage(messageId);
  const parsed  = parseMessage(msg);
  const result  = { brand: null, emailType: 'unknown', senderChanged: false };

  const senderEmail  = extractSenderEmail(parsed.from);
  const senderDomain = normalizeDomain(extractDomainFromEmail(senderEmail));

  if (!senderEmail || !senderDomain) return result;

  const emailType = classifyEmailType(parsed.subject, parsed.bodyText, parsed.bodyHtml);
  result.emailType = emailType;

  // Skip non-brand emails (confirmations we sent, system emails, etc.)
  if (['transactional', 'other'].includes(emailType) && !senderDomain.includes('.com')) {
    return result;
  }

  // -- Find matching brand ----------------------------------------
  let brand = await Brand.findBySenderEmail(senderEmail);

  if (!brand) {
    // Try matching by domain
    brand = await Brand.findByDomain(getRegistrableDomain(senderDomain));
  }

  if (!brand && senderDomain) {
    brand = await Brand.findOne({
      knownSenderDomains: { $regex: new RegExp(`^${senderDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
  }

  if (!brand && senderDomain) {
    const root = getRegistrableDomain(senderDomain);
    brand = await Brand.findOne({
      knownSenderDomains: { $regex: new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
  }

  if (!brand) {
    // No match found - this might be an email from a brand we haven't tracked yet,
    // or a sender domain change we haven't seen. Log for manual review.
    logger.debug(`Unmatched email from ${senderEmail}: "${parsed.subject}"`);
    return result;
  }

  result.brand = brand;

  // -- Detect sender email change -------------------------------
  if (brand.currentSenderEmail &&
      brand.currentSenderEmail.toLowerCase() !== senderEmail.toLowerCase()) {
    const currentDomain = normalizeDomain(extractDomainFromEmail(brand.currentSenderEmail));
    logger.info(` Sender change detected for ${brand.name}:`);
    logger.info(`   Old: ${brand.currentSenderEmail}`);
    logger.info(`   New: ${senderEmail}`);
    if (domainsRelated(currentDomain, senderDomain)) {
      logger.info('   Domain network unchanged (local part/subdomain rotation)');
    }

    await brand.recordSenderChange(senderEmail);
    result.senderChanged = true;
  } else if (!brand.currentSenderEmail) {
    // First time seeing this sender - set it
    brand.currentSenderEmail = senderEmail;
    brand.senderEmailHistory.push({ email: senderEmail, reason: 'initial' });
  }

  // -- Update brand email activity -------------------------------
  brand.totalEmailsReceived = (brand.totalEmailsReceived || 0) + 1;
  brand.lastHealthCheckAt   = new Date();
  brand.isStale             = false;
  if (senderDomain) {
    const senderDomainSet = new Set((brand.knownSenderDomains || []).map((domain) => String(domain).toLowerCase()));
    senderDomainSet.add(senderDomain);
    senderDomainSet.add(getRegistrableDomain(senderDomain));
    brand.knownSenderDomains = Array.from(senderDomainSet).filter(Boolean);
    brand.currentSenderDomain = brand.currentSenderDomain || senderDomain;
    brand.primarySenderDomain = brand.primarySenderDomain || senderDomain;
  }

  if (emailType === 'welcome' && !brand.welcomeEmailReceived) {
    brand.welcomeEmailReceived   = true;
    brand.welcomeEmailReceivedAt = new Date();
    brand.welcomeEmailMessageId  = messageId;
    logger.info(`   Welcome email recorded for ${brand.name}`);
  }

  if (emailType === 'newsletter' || emailType === 'promotional') {
    if (!brand.firstNewsletterAt) {
      brand.firstNewsletterAt = new Date();
      logger.info(`   First newsletter recorded for ${brand.name}`);
    }
    brand.lastNewsletterAt = new Date();

    // Capture sample subject lines (up to 5)
    if ((brand.sampleSubjectLines || []).length < 5) {
      brand.sampleSubjectLines = brand.sampleSubjectLines || [];
      if (!brand.sampleSubjectLines.includes(parsed.subject)) {
        brand.sampleSubjectLines.push(parsed.subject);
      }
    }

    // Store sample emails (up to 5)
    if ((brand.sampleEmails || []).length < 5) {
      brand.sampleEmails = brand.sampleEmails || [];
      brand.sampleEmails.push({
        subject:    parsed.subject,
        receivedAt: new Date(parseInt(parsed.internalDate)),
        messageId,
        type:       emailType
      });
    }

    // Estimate newsletter frequency
    await updateFrequencyEstimate(brand);

    // If brand was awaiting confirmation and we got a newsletter, mark as active
    if (brand.onboardingStatus === 'awaiting_confirmation') {
      await brand.updateStatus('active', 'First newsletter received');
    }
  }

  await brand.save();
  return result;
}

/**
 * Scan all recent Gmail messages and process any from tracked brands.
 * Run this periodically (e.g., every 30 minutes) to keep the DB fresh.
 * @param {number} hours - How many hours back to scan
 */
async function scanRecentEmails(hours = 1) {
  logger.info(` Scanning last ${hours}h of Gmail for brand emails...`);

  const since = Math.floor((Date.now() - hours * 3600000) / 1000);
  const messages = await searchMessages(`to:${process.env.GMAIL_USER} after:${since}`, 50);

  let processed = 0, senderChanges = 0;

  for (const msgRef of messages) {
    try {
      const result = await processIncomingEmail(msgRef.id);
      if (result.brand) {
        processed++;
        if (result.senderChanged) senderChanges++;
      }
      await sleep(200); // Rate limit Gmail API calls
    } catch (err) {
      logger.warn(`Error processing message ${msgRef.id}: ${err.message}`);
    }
  }

  logger.info(`  [OK] Processed ${processed} brand emails, ${senderChanges} sender changes detected`);
  return { processed, senderChanges };
}

/**
 * Mark brands as stale if they haven't sent a newsletter in 60+ days.
 */
async function detectStaleBrands(inactiveDays = 60) {
  const cutoff = new Date(Date.now() - inactiveDays * 24 * 3600 * 1000);

  const staleBrands = await Brand.find({
    onboardingStatus: 'active',
    lastNewsletterAt: { $lt: cutoff },
    isStale: { $ne: true }
  });

  for (const brand of staleBrands) {
    brand.isStale = true;
    await brand.save();
    logger.warn(`[WARN]  Brand marked as stale (no email in ${inactiveDays}d): ${brand.name}`);
  }

  return staleBrands.length;
}

/**
 * Estimate how frequently a brand sends newsletters based on received email history.
 */
async function updateFrequencyEstimate(brand) {
  const emails = brand.sampleEmails || [];
  if (emails.length < 2) return;

  const dates  = emails.map(e => new Date(e.receivedAt)).sort((a, b) => a - b);
  const gaps   = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / (1000 * 3600 * 24)); // days
  }

  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  if      (avgGap <= 1.5)   brand.newsletterFrequency = 'daily';
  else if (avgGap <= 4)     brand.newsletterFrequency = '2x_week';
  else if (avgGap <= 8)     brand.newsletterFrequency = 'weekly';
  else if (avgGap <= 18)    brand.newsletterFrequency = 'biweekly';
  else if (avgGap <= 45)    brand.newsletterFrequency = 'monthly';
  else                      brand.newsletterFrequency = 'sporadic';
}

module.exports = { processIncomingEmail, scanRecentEmails, detectStaleBrands };
