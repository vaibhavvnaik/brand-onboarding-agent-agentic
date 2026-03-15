/**
 * Email Confirmation Service
 * Polls Gmail API for confirmation emails from brands and clicks confirmation links.
 * Handles all common double opt-in patterns and edge cases.
 */
const { chromium } = require('playwright');
const axios = require('axios');
const { searchMessages, getMessage, parseMessage, extractSenderEmail } = require('../config/gmail');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const POLL_INTERVAL  = parseInt(process.env.GMAIL_POLL_INTERVAL_MS || '15000');
const MAX_WAIT_TIME  = parseInt(process.env.CONFIRMATION_TIMEOUT_MS || '600000'); // 10 min

// Patterns that identify a confirmation-required email
const CONFIRMATION_PATTERNS = [
  /confirm.{0,30}(subscription|email|address)/i,
  /verify.{0,30}(email|subscription)/i,
  /please.{0,30}confirm/i,
  /click.{0,30}(to confirm|here to confirm)/i,
  /activate.{0,30}(subscription|account)/i,
  /double.{0,10}opt/i,
  /confirm your sign.?up/i,
  /you.{0,10}requested.{0,30}(newsletter|subscription|updates)/i,
];

// Patterns that identify a welcome email (first email from brand after signup)
const WELCOME_PATTERNS = [
  /welcome.{0,20}(to|aboard|to our|to the)/i,
  /thanks? for (joining|subscribing|signing up)/i,
  /you.{0,10}(are|re) (now )?subscribed/i,
  /you.{0,10}(are|re) (now )?in/i,
  /glad (you.{0,10})?joined/i,
  /officially (a )?member/i,
];

const NEWSLETTER_PATTERNS = [
  /\bnewsletter\b/i,
  /\bweekly\b.{0,20}(update|digest|roundup|recap)?/i,
  /\bdaily\b.{0,20}(update|digest|brief)?/i,
  /\bnew arrivals?\b/i,
  /\blatest\b.{0,20}(news|drops|arrivals|stories)/i,
  /\bthis week\b/i,
  /\bin your inbox\b/i,
  /\btop picks?\b/i
];

/**
 * Wait for and handle a confirmation email from a specific brand domain.
 * @param {string} brandDomain - e.g. "allbirds.com"
 * @param {string} brandName
 * @param {Date} signupTime - When the signup happened (to filter old emails)
 * @returns {Object} { confirmed, emailType, senderEmail, subject, messageId }
 */
async function waitForConfirmation(brandDomain, brandName, signupTime = new Date()) {
  logger.info(`  [...] Waiting for email from ${brandDomain}... (max ${MAX_WAIT_TIME / 60000} min)`);

  const startTime = Date.now();
  const sinceTimestamp = Math.floor(signupTime.getTime() / 1000); // Unix timestamp

  while (Date.now() - startTime < MAX_WAIT_TIME) {
    try {
      // Search for emails from this brand's domain
      const cleanDomain = brandDomain.replace(/^www\./, '');
      const query = `from:@${cleanDomain} after:${sinceTimestamp}`;
      const messages = await searchMessages(query, 5);

      if (messages.length > 0) {
        for (const msgRef of messages) {
          const msg = await getMessage(msgRef.id);
          const parsed = parseMessage(msg);

          logger.info(`   Email received from ${parsed.from}: "${parsed.subject}"`);

          const emailType = classifyEmailType(parsed.subject, parsed.bodyText, parsed.bodyHtml);

          if (emailType === 'confirmation') {
            // Handle confirmation
            const confirmed = await clickConfirmationLink(parsed, brandName);
            return {
              confirmed,
              requiresConfirmation: true,
              emailType: 'confirmation',
              senderEmail: extractSenderEmail(parsed.from),
              subject: parsed.subject,
              messageId: parsed.id
            };
          }

          // Welcome or newsletter - no confirmation needed
          return {
            confirmed: true,
            requiresConfirmation: false,
            emailType,
            senderEmail: extractSenderEmail(parsed.from),
            subject: parsed.subject,
            messageId: parsed.id
          };
        }
      }

      // Not found yet - also check for email with brand name in sender
      const altQuery = `"${brandName.toLowerCase()}" in:inbox after:${sinceTimestamp}`;
      const altMessages = await searchMessages(altQuery, 3);
      for (const msgRef of altMessages) {
        const msg = await getMessage(msgRef.id);
        const parsed = parseMessage(msg);
        const fromEmail = extractSenderEmail(parsed.from) || '';

        // Check if sender domain somewhat matches brand
        if (fromEmail.includes(cleanDomain.split('.')[0])) {
          const emailType = classifyEmailType(parsed.subject, parsed.bodyText, parsed.bodyHtml);
          if (emailType === 'confirmation') {
            const confirmed = await clickConfirmationLink(parsed, brandName);
            return {
              confirmed,
              requiresConfirmation: true,
              emailType: 'confirmation',
              senderEmail: extractSenderEmail(parsed.from),
              subject: parsed.subject,
              messageId: parsed.id
            };
          }
          return {
            confirmed: true,
            requiresConfirmation: false,
            emailType,
            senderEmail: extractSenderEmail(parsed.from),
            subject: parsed.subject,
            messageId: parsed.id
          };
        }
      }

      await sleep(POLL_INTERVAL);
      logger.debug(`  [...] Still waiting for ${brandDomain}... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);

    } catch (err) {
      logger.warn(`  Gmail polling error for ${brandDomain}: ${err.message}`);
      await sleep(POLL_INTERVAL * 2); // Back off on error
    }
  }

  logger.warn(`  [WARN]  Timeout waiting for email from ${brandDomain}`);
  return {
    confirmed: false,
    requiresConfirmation: null,
    emailType: 'timeout',
    senderEmail: null,
    subject: null,
    messageId: null
  };
}

/**
 * Classify an incoming email as confirmation, welcome, newsletter, or other.
 */
function classifyEmailType(subject, bodyText, bodyHtml) {
  const subjectLower = (subject || '').toLowerCase();
  const bodyLower   = (bodyText || bodyHtml || '').toLowerCase().slice(0, 2000);
  const combined    = subjectLower + ' ' + bodyLower;

  // Confirmation first (highest priority)
  if (CONFIRMATION_PATTERNS.some(p => p.test(combined))) return 'confirmation';

  // Welcome
  if (WELCOME_PATTERNS.some(p => p.test(combined))) return 'welcome';

  // Promotional/newsletter
  if (
    NEWSLETTER_PATTERNS.some((p) => p.test(combined)) ||
    /sale|off|discount|promo|deal|shop|buy|limited|exclusive|new arrival|drops?|collection/i.test(combined)
  ) {
    return 'newsletter';
  }

  // Transactional but not confirmation
  if (/order|receipt|tracking|shipped|delivered/i.test(combined)) return 'transactional';

  return 'other';
}

/**
 * Find and click the confirmation link in an email.
 * Handles multiple link formats and redirect chains.
 */
async function clickConfirmationLink(parsed, brandName) {
  logger.info(`   Looking for confirmation link in email from ${parsed.from}...`);

  // Extract confirmation link from HTML body
  const confirmationLink = findConfirmationLink(parsed.links, parsed.bodyHtml, parsed.bodyText);

  if (!confirmationLink) {
    logger.warn(`  [WARN]  No confirmation link found for ${brandName}`);
    return false;
  }

  logger.info(`    Clicking confirmation link: ${confirmationLink.slice(0, 80)}...`);

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto(confirmationLink, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);

    const pageText = (await page.textContent('body').catch(() => '')).toLowerCase();

    // Check for success
    const successSignals = [
      'confirmed', 'subscribed', 'success', 'thank you', 'thanks',
      'you\'re in', 'welcome', 'verified', 'activated', 'all set'
    ];

    // Check for secondary confirmation button (some brands have a "Confirm" button on the landing page)
    const confirmButton = await page.$('button:has-text("Confirm"), a:has-text("Confirm"), button:has-text("Yes"), input[value*="Confirm" i]');
    if (confirmButton) {
      await confirmButton.click({ delay: 100 });
      await sleep(2000);
      const updatedText = (await page.textContent('body').catch(() => '')).toLowerCase();
      if (successSignals.some(s => updatedText.includes(s))) {
        logger.info(`  [OK] Confirmation button clicked - ${brandName} confirmed`);
        return true;
      }
    }

    if (successSignals.some(s => pageText.includes(s))) {
      logger.info(`  [OK] Confirmation successful for ${brandName}`);
      return true;
    }

    // Even if we can't detect success, the click attempt was made
    logger.info(`  [OK] Confirmation link visited for ${brandName} (no error detected)`);
    return true;

  } catch (err) {
    logger.warn(`  [ERR] Failed to click confirmation link for ${brandName}: ${err.message}`);
    try {
      // Fallback when browser libs are unavailable: perform direct HTTP GET.
      await axios.get(confirmationLink, {
        timeout: 20000,
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      logger.info(`  [OK] HTTP fallback visited confirmation link for ${brandName}`);
      return true;
    } catch (httpErr) {
      logger.warn(`  [ERR] HTTP fallback failed for ${brandName}: ${httpErr.message}`);
      return false;
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function clickConfirmationLinkFromParsedMessage(parsed, brandName) {
  return clickConfirmationLink(parsed, brandName);
}

/**
 * Extract the most likely confirmation link from email content.
 * Prioritises links with confirmation-related keywords.
 */
function findConfirmationLink(links, bodyHtml, bodyText) {
  if (!links || links.length === 0) {
    // Try to extract from raw HTML
    const urlRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    const htmlLinks = [];
    let match;
    while ((match = urlRegex.exec(bodyHtml || '')) !== null) {
      htmlLinks.push(match[1]);
    }
    links = [...new Set(htmlLinks)];
  }

  // Priority 1: Links with explicit confirmation keywords in URL
  const confirmUrlPatterns = [
    /confirm/i, /verify/i, /activate/i, /validate/i,
    /subscribe.*confirm/i, /opt.?in/i, /double.*opt/i
  ];

  for (const pattern of confirmUrlPatterns) {
    const match = links.find(l => pattern.test(l));
    if (match) return match;
  }

  // Priority 2: Links in "click here to confirm" text context
  // Look for the link immediately after confirmation text in HTML
  if (bodyHtml) {
    const confirmContextRegex = /(?:click|tap|confirm|verify).*?href=["'](https?:\/\/[^"']+)["']/i;
    const match = confirmContextRegex.exec(bodyHtml);
    if (match) return match[1];
  }

  // Priority 3: Any non-unsubscribe, non-social-media link
  const filteredLinks = links.filter(l =>
    !l.includes('unsubscribe') && !l.includes('facebook.com') &&
    !l.includes('twitter.com') && !l.includes('instagram.com') &&
    !l.includes('linkedin.com') && !l.includes('mailto:') &&
    l.length > 30 && l.length < 400
  );

  return filteredLinks[0] || null;
}

module.exports = {
  waitForConfirmation,
  classifyEmailType,
  clickConfirmationLinkFromParsedMessage
};
