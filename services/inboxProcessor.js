const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const Config = require('../models/Config');
const axios = require('axios');
const {
  getGmailClient,
  gmailCall,
  getMessage,
  parseMessage,
  extractSenderEmail,
  extractDomainFromEmail
} = require('../config/gmail');
const { classifyEmailType } = require('./emailConfirmation');
const {
  normalizeDomain,
  getRegistrableDomain,
  domainsRelated,
  extractDomainFromUrl
} = require('../utils/domainIdentity');
const { scrubSensitiveContent, scrubSensitiveContentDeep } = require('../utils/contentScrubber');
const { markEmailActivity } = require('./gmailStatusLabels');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BRAND_MATCH_CONFIDENCE_THRESHOLD = Math.max(
  0,
  Number(process.env.BRAND_MATCH_CONFIDENCE_THRESHOLD || 9)
);
const SCAN_CURSOR_CONFIG_KEY = 'scan_inbox_cursor_v1';
const SCAN_CURSOR_OVERLAP_SECONDS = Math.max(
  60,
  Number(process.env.SCAN_CURSOR_OVERLAP_SECONDS || 300)
);

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMeaningfulLinkDomains(links = []) {
  const ignored = new Set([
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
    'youtube.com', 'tiktok.com', 'pinterest.com',
    'shopify.com', 'myshopify.com', 'shopifycdn.com',
    'mailchimp.com', 'klaviyomail.com', 'sendgrid.net', 'mandrillapp.com',
    'google.com', 'googleusercontent.com', 'doubleclick.net'
  ]);
  const domains = new Set();
  for (const link of links || []) {
    const d = extractDomainFromUrl(link);
    if (!d) continue;
    const reg = getRegistrableDomain(d);
    if (!reg || ignored.has(reg)) continue;
    domains.add(d);
    domains.add(reg);
  }
  return Array.from(domains);
}

function shouldTrackAsExternalSender(senderDomain, brandDomain) {
  if (!senderDomain || !brandDomain) return false;
  return !domainsRelated(senderDomain, brandDomain);
}

function extractListIdDomain(listId = '') {
  const raw = String(listId || '').toLowerCase().trim();
  if (!raw) return '';
  const trimmed = raw.replace(/[<>]/g, '');
  const pieces = trimmed.split('@');
  if (pieces.length === 2) return normalizeDomain(pieces[1]);
  return normalizeDomain(trimmed.split(/\s+/)[0]);
}

function countDomainMatchInSnapshots(linkSnapshots = [], brandDomain = '') {
  if (!brandDomain) return 0;
  const brandApex = getRegistrableDomain(brandDomain) || normalizeDomain(brandDomain);
  let count = 0;
  for (const snap of linkSnapshots || []) {
    const domain = normalizeDomain(snap?.finalDomain || snap?.originalDomain || '');
    if (!domain) continue;
    if (domainsRelated(domain, brandApex)) count += 1;
  }
  return count;
}

function upsertExternalSenderEvidence(brand, {
  senderEmail,
  senderDomain,
  senderApexDomain,
  matchSource,
  matchConfidence,
  linkMatchesBrand,
  listIdMatchesBrand
}) {
  if (!senderEmail) return null;
  const now = new Date();
  brand.externalSenderEvidence = brand.externalSenderEvidence || [];
  let entry = (brand.externalSenderEvidence || []).find((row) => row.senderEmail === senderEmail);
  if (!entry) {
    entry = {
      senderEmail,
      senderDomain: senderDomain || '',
      senderApexDomain: senderApexDomain || '',
      firstSeenAt: now,
      lastSeenAt: now,
      evidenceCount: 0,
      linkMatchesBrandDomainCount: 0,
      listIdMatchesBrandCount: 0,
      highConfidenceMatchCount: 0
    };
    brand.externalSenderEvidence.push(entry);
  }

  entry.lastSeenAt = now;
  entry.evidenceCount = Number(entry.evidenceCount || 0) + 1;
  if (linkMatchesBrand) entry.linkMatchesBrandDomainCount = Number(entry.linkMatchesBrandDomainCount || 0) + 1;
  if (listIdMatchesBrand) entry.listIdMatchesBrandCount = Number(entry.listIdMatchesBrandCount || 0) + 1;
  if (matchConfidence >= 8) entry.highConfidenceMatchCount = Number(entry.highConfidenceMatchCount || 0) + 1;
  entry.lastMatchSource = matchSource || 'unknown';
  entry.lastMatchConfidence = Number(matchConfidence || 0);
  return entry;
}

function maybePromoteExternalSenderAlias(brand, entry, senderEmail, senderApexDomain) {
  if (!entry || !senderEmail) return;
  if (String(entry.reviewStatus || '').toLowerCase() === 'rejected') return;
  const minEmailCount = Math.max(1, Number(process.env.EXTERNAL_SENDER_PROMOTION_MIN_COUNT || 3));
  const minDomainCount = Math.max(2, Number(process.env.EXTERNAL_SENDER_DOMAIN_PROMOTION_MIN_COUNT || 6));
  const allowDomainPromotion = String(process.env.ALLOW_EXTERNAL_SENDER_DOMAIN_PROMOTION || 'false').toLowerCase() === 'true';

  const strongProofCount = Number(entry.linkMatchesBrandDomainCount || 0) + Number(entry.listIdMatchesBrandCount || 0);
  const canPromoteEmail = Number(entry.evidenceCount || 0) >= minEmailCount && strongProofCount > 0;

  if (canPromoteEmail) {
    const knownEmails = new Set((brand.knownSenderEmails || []).map((value) => String(value).toLowerCase()));
    if (!knownEmails.has(senderEmail)) {
      knownEmails.add(senderEmail);
      brand.knownSenderEmails = Array.from(knownEmails);
      entry.promotedEmailAt = entry.promotedEmailAt || new Date();
      entry.reviewStatus = 'approved';
      entry.reviewedAt = entry.reviewedAt || new Date();
      const history = brand.senderEmailHistory || [];
      if (!history.find((row) => row.email === senderEmail)) {
        history.push({
          email: senderEmail,
          reason: 'manual',
          firstSeenAt: new Date(),
          lastSeenAt: new Date()
        });
      }
      brand.senderEmailHistory = history;
    }
  }

  if (allowDomainPromotion && senderApexDomain) {
    const canPromoteDomain = Number(entry.evidenceCount || 0) >= minDomainCount && Number(entry.linkMatchesBrandDomainCount || 0) >= minEmailCount;
    if (canPromoteDomain) {
      const knownDomains = new Set((brand.knownSenderDomains || []).map((value) => String(value).toLowerCase()));
      if (!knownDomains.has(senderApexDomain)) {
        knownDomains.add(senderApexDomain);
        brand.knownSenderDomains = Array.from(knownDomains);
        entry.promotedDomainAt = entry.promotedDomainAt || new Date();
        entry.reviewStatus = 'approved';
        entry.reviewedAt = entry.reviewedAt || new Date();
      }
    }
  }
}

async function resolveSingleLinkSnapshot(url) {
  const originalUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(originalUrl)) {
    return {
      originalUrl,
      originalDomain: extractDomainFromUrl(originalUrl),
      finalUrl: null,
      finalDomain: null,
      resolvedAt: new Date(),
      statusCode: null,
      error: 'invalid_url'
    };
  }

  const timeout = Number(process.env.LINK_RESOLUTION_TIMEOUT_MS || 5000);
  try {
    let res;
    try {
      res = await axios.head(originalUrl, {
        timeout,
        maxRedirects: 8,
        validateStatus: () => true
      });
    } catch (_) {
      res = await axios.get(originalUrl, {
        timeout,
        maxRedirects: 8,
        validateStatus: () => true
      });
    }
    const finalUrl = res?.request?.res?.responseUrl || originalUrl;
    return {
      originalUrl,
      originalDomain: extractDomainFromUrl(originalUrl),
      finalUrl,
      finalDomain: extractDomainFromUrl(finalUrl),
      resolvedAt: new Date(),
      statusCode: Number(res?.status || 0) || null,
      error: null
    };
  } catch (err) {
    return {
      originalUrl,
      originalDomain: extractDomainFromUrl(originalUrl),
      finalUrl: null,
      finalDomain: null,
      resolvedAt: new Date(),
      statusCode: Number(err?.response?.status || 0) || null,
      error: err?.message || 'resolution_failed'
    };
  }
}

async function buildLinkSnapshots(links = []) {
  const uniqueLinks = Array.from(new Set((links || []).map((url) => String(url || '').trim()).filter(Boolean)));
  const maxLinks = Math.max(0, Number(process.env.LINK_RESOLUTION_MAX_LINKS || 5));
  const selected = uniqueLinks.slice(0, maxLinks || uniqueLinks.length);
  const enabled = String(process.env.LINK_RESOLUTION_ENABLED || 'false').toLowerCase() === 'true';

  if (!selected.length) return [];
  if (!enabled) {
    return selected.map((originalUrl) => ({
      originalUrl,
      originalDomain: extractDomainFromUrl(originalUrl),
      finalUrl: null,
      finalDomain: null,
      resolvedAt: null,
      statusCode: null,
      error: 'resolution_disabled'
    }));
  }

  const snapshots = [];
  for (const link of selected) {
    // Intentionally sequential to avoid aggressive bursts during full-history scans.
    snapshots.push(await resolveSingleLinkSnapshot(link));
  }
  return snapshots;
}

async function enqueueManualReview({
  emailMessage,
  parsed,
  reason,
  candidateBrand = null,
  matchSource = 'unknown',
  matchConfidence = 0
}) {
  try {
    const db = EmailMessage.db;
    const queue = db.collection('manual_review_queue');
    const now = new Date();
    await queue.updateOne(
      { gmailMessageId: emailMessage.gmailMessageId },
      {
        $set: {
          emailMessageId: emailMessage._id,
          gmailMessageId: emailMessage.gmailMessageId,
          fromEmail: emailMessage.fromEmail || null,
          fromDomain: emailMessage.fromDomain || null,
          subject: emailMessage.subject || null,
          receivedAt: emailMessage.receivedAt || null,
          reason,
          matchSource,
          matchConfidence,
          threshold: BRAND_MATCH_CONFIDENCE_THRESHOLD,
          candidateBrandId: candidateBrand?._id || null,
          candidateBrandName: candidateBrand?.name || null,
          candidateBrandDomain: candidateBrand?.domain || null,
          snippet: parsed?.snippet || emailMessage.snippet || null,
          status: 'pending',
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
  } catch (err) {
    logger.warn(`[scan_inbox] Failed to enqueue manual review for ${emailMessage.gmailMessageId}: ${err.message}`);
  }
}

async function markUnresolvedForManualReview({
  emailMessage,
  parsed,
  emailType,
  reason,
  matchSource = 'unknown',
  matchConfidence = 0,
  candidateBrand = null
}) {
  emailMessage.state = 'brand_unresolved';
  emailMessage.needsReview = true;
  emailMessage.processedBy.identity_resolver = {
    done: false,
    at: new Date(),
    version: 'v2',
    attempts: (emailMessage.processedBy?.identity_resolver?.attempts || 0) + 1,
    status: 'skipped',
    lastProcessedAt: new Date(),
    error: reason
  };
  emailMessage.classificationConfidence = matchConfidence;
  emailMessage.classificationReason = matchSource;
  emailMessage.processingTrace = {
    ...(emailMessage.processingTrace || {}),
    resolve: {
      at: new Date(),
      status: 'manual_review',
      reason,
      source: matchSource,
      confidence: matchConfidence,
      threshold: BRAND_MATCH_CONFIDENCE_THRESHOLD
    }
  };
  await emailMessage.save();
  await enqueueManualReview({
    emailMessage,
    parsed,
    reason,
    candidateBrand,
    matchSource,
    matchConfidence
  });
  await markEmailActivity({
    gmailMessageId: emailMessage.gmailMessageId,
    activity: 'processed',
    parsed,
    emailMessage
  });
  return {
    matched: false,
    emailType,
    manualReview: true,
    gmailMessageId: emailMessage.gmailMessageId,
    receivedAt: emailMessage.receivedAt || null
  };
}

function inferNewsletterLikeType(parsed, detectedType, brand) {
  const currentType = String(detectedType || 'unknown');
  if (['newsletter', 'welcome', 'confirmation', 'transactional'].includes(currentType)) return currentType;

  const onboardingStatus = String(brand?.onboardingStatus || '');
  const shouldAttemptInference = ['awaiting_confirmation', 'subscribing', 'submitted', 'discovered', 'failed', 'captcha_blocked'].includes(onboardingStatus);
  if (!shouldAttemptInference) return currentType;

  const subject = String(parsed?.subject || '').toLowerCase();
  const body = String(parsed?.bodyText || parsed?.bodyHtml || '').toLowerCase().slice(0, 4000);
  const links = Array.isArray(parsed?.links) ? parsed.links : [];
  const combined = `${subject} ${body}`;

  const strongNewsletterSignals = [
    'unsubscribe',
    'manage preferences',
    'email preferences',
    'view in browser',
    'why did i get this email',
    'you received this email',
    'update your preferences'
  ];
  const mediumSignals = [
    'new arrivals',
    'just dropped',
    'shop now',
    'shop the',
    'read more',
    'latest',
    'collection',
    'lookbook',
    'this week'
  ];

  const hasStrongSignal = strongNewsletterSignals.some((signal) => combined.includes(signal));
  const mediumSignalHits = mediumSignals.filter((signal) => combined.includes(signal)).length;
  const meaningfulLinkCount = links.filter((url) => /^https?:\/\//i.test(String(url))).length;

  if (hasStrongSignal && meaningfulLinkCount >= 1) return 'newsletter';
  if (mediumSignalHits >= 2 && meaningfulLinkCount >= 2) return 'newsletter';
  if (meaningfulLinkCount >= 5 && combined.includes('unsubscribe')) return 'newsletter';
  return currentType;
}

function normalizeNameForMatch(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildEmailReferenceText(parsed) {
  return [
    parsed?.subject || '',
    parsed?.snippet || '',
    parsed?.bodyText || '',
    parsed?.bodyHtml || ''
  ].join(' ').toLowerCase().slice(0, 8000);
}

async function resolveBrandByContentReference(parsed, senderDomain, emailType) {
  const text = buildEmailReferenceText(parsed);
  if (!text) return null;

  const pendingStatuses = ['failed', 'captcha_blocked', 'awaiting_confirmation', 'subscribing', 'submitted', 'discovered'];
  const domainMatches = new Set();
  const domainRegex = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/gi;
  let match;
  while ((match = domainRegex.exec(text)) !== null) {
    const rawDomain = normalizeDomain(match[1]);
    const root = getRegistrableDomain(rawDomain);
    if (root) domainMatches.add(root);
  }

  const linkDomains = extractMeaningfulLinkDomains(parsed?.links || []);
  for (const domain of linkDomains) domainMatches.add(getRegistrableDomain(domain));
  if (senderDomain) domainMatches.add(getRegistrableDomain(senderDomain));

  const candidateDomains = Array.from(domainMatches).filter(Boolean);
  if (candidateDomains.length) {
    const byDomain = await Brand.findOne({
      onboardingStatus: { $in: pendingStatuses },
      domain: { $in: candidateDomains }
    }).sort({ updatedAt: -1 });
    if (byDomain) {
      return { brand: byDomain, source: 'content_domain_match', confidence: 9 };
    }
  }

  if (!['welcome', 'newsletter'].includes(String(emailType || ''))) return null;

  const phrasePatterns = [
    /welcome to\s+([a-z0-9&' -]{2,40})/i,
    /thanks for (?:joining|subscribing(?: to)?|signing up(?: for)?)\s+([a-z0-9&' -]{2,40})/i,
    /you(?:'re| are) (?:now )?subscribed to\s+([a-z0-9&' -]{2,40})/i
  ];

  const phrases = new Set();
  for (const pattern of phrasePatterns) {
    const found = text.match(pattern);
    if (found && found[1]) phrases.add(normalizeNameForMatch(found[1]));
  }
  if (!phrases.size) return null;

  const candidates = await Brand.find({
    onboardingStatus: { $in: pendingStatuses }
  }).select('name domain onboardingStatus').limit(600);

  let best = null;
  let bestScore = 0;
  for (const brand of candidates) {
    const brandName = normalizeNameForMatch(brand.name);
    if (!brandName) continue;
    let score = 0;
    for (const phrase of phrases) {
      if (!phrase) continue;
      if (phrase === brandName) score += 8;
      else if (brandName.includes(phrase) || phrase.includes(brandName)) score += 5;
    }
    if (senderDomain && domainsRelated(senderDomain, brand.domain)) score += 4;
    if (text.includes(brandName)) score += 2;
    if (score > bestScore) {
      best = brand;
      bestScore = score;
    }
  }

  if (best && bestScore >= 8) {
    return { brand: best, source: 'content_brand_phrase', confidence: bestScore };
  }
  return null;
}

async function resolveBrand(senderEmail, senderDomain, links = []) {
  if (!senderEmail && !senderDomain) return null;

  if (senderEmail) {
    const byExactSender = await Brand.findOne({
      currentSenderEmail: { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byExactSender) return byExactSender;

    const byKnownSenders = await Brand.findOne({
      knownSenderEmails: { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byKnownSenders) return byKnownSenders;

    const byHistory = await Brand.findOne({
      'senderEmailHistory.email': { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byHistory) return byHistory;

    const byWelcomeSenders = await Brand.findOne({
      welcomeSenderEmails: { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byWelcomeSenders) return byWelcomeSenders;
  }

  if (senderDomain) {
    const cleanDomain = normalizeDomain(senderDomain);
    const apex = getRegistrableDomain(cleanDomain);
    const byExactDomain = await Brand.findOne({
      domain: { $regex: new RegExp(`^${escapeRegex(cleanDomain)}$`, 'i') }
    });
    if (byExactDomain) return byExactDomain;

    const byApexDomain = await Brand.findOne({
      domain: { $regex: new RegExp(`^${escapeRegex(apex)}$`, 'i') }
    });
    if (byApexDomain) return byApexDomain;

    const byKnownSenderDomain = await Brand.findOne({
      knownSenderDomains: { $regex: new RegExp(`^${escapeRegex(cleanDomain)}$`, 'i') }
    });
    if (byKnownSenderDomain) return byKnownSenderDomain;

    const byKnownSenderApex = await Brand.findOne({
      knownSenderDomains: { $regex: new RegExp(`^${escapeRegex(apex)}$`, 'i') }
    });
    if (byKnownSenderApex) return byKnownSenderApex;
  }

  const linkDomains = extractMeaningfulLinkDomains(links);
  if (linkDomains.length) {
    const roots = Array.from(new Set(linkDomains.map((domain) => getRegistrableDomain(domain)).filter(Boolean)));
    if (roots.length) {
      const byLinkRoots = await Brand.find({ domain: { $in: roots } }).limit(3);
      if (byLinkRoots.length === 1) return byLinkRoots[0];

      if (byLinkRoots.length > 1 && senderDomain) {
        const senderRoot = getRegistrableDomain(senderDomain);
        const related = byLinkRoots.find((brand) => domainsRelated(senderRoot, brand.domain));
        if (related) return related;
      }
    }
  }

  return null;
}

async function upsertEmailMessage(parsed) {
  const safeFrom = scrubSensitiveContent(parsed.from || '');
  const safeTo = scrubSensitiveContent(parsed.to || '');
  const safeSubject = scrubSensitiveContent(parsed.subject || '');
  const safeSnippet = scrubSensitiveContent(parsed.snippet || '');
  const safeBodyText = scrubSensitiveContent(parsed.bodyText || '');
  const safeBodyHtml = scrubSensitiveContent(parsed.bodyHtml || '');
  const safeHeaders = {
    ...(scrubSensitiveContentDeep(parsed.rawHeaders || {})),
    messageId: parsed.messageId || null,
    from: safeFrom,
    to: safeTo,
    subject: safeSubject,
    date: scrubSensitiveContent(parsed.date || '')
  };

  const senderEmail = extractSenderEmail(parsed.from);
  const senderDomain = normalizeDomain(extractDomainFromEmail(senderEmail));
  const senderApexDomain = getRegistrableDomain(senderDomain || '') || senderDomain || '';
  const senderSubdomain = senderDomain && senderApexDomain && senderDomain !== senderApexDomain
    ? senderDomain.replace(new RegExp(`\\.?${escapeRegex(senderApexDomain)}$`), '').replace(/\.$/, '')
    : '';
  const emailType = classifyEmailType(parsed.subject, parsed.bodyText, parsed.bodyHtml);
  const linkSnapshots = await buildLinkSnapshots(parsed.links || []);
  const receivedAt = parsed.internalDate ? new Date(Number(parsed.internalDate)) : new Date();

  const emailMessage = await EmailMessage.findOneAndUpdate(
    { gmailMessageId: parsed.id },
    {
      $set: {
        gmailThreadHistoryId: parsed.historyId || null,
        gmailLabelIds: parsed.labelIds || [],
        gmailSizeEstimate: parsed.sizeEstimate || 0,
        threadId: parsed.threadId,
        from: safeFrom,
        fromEmail: senderEmail,
        fromDomain: senderDomain,
        senderApexDomain,
        senderSubdomain,
        to: safeTo,
        subject: safeSubject,
        snippet: safeSnippet,
        receivedAt,
        rfc822MessageId: parsed.messageId || null,
        listUnsubscribe: parsed.listUnsubscribe || null,
        listUnsubscribePost: parsed.listUnsubscribePost || null,
        listId: parsed.listId || null,
        precedence: parsed.precedence || null,
        replyTo: parsed.replyTo || null,
        returnPath: parsed.returnPath || null,
        inReplyTo: parsed.inReplyTo || null,
        references: parsed.references || null,
        authenticationResults: parsed.authenticationResults || null,
        espHeaders: parsed.espHeaders || {},
        attachmentMetadata: parsed.attachments || [],
        mimeMeta: parsed.mimeMeta || {},
        textBody: safeBodyText,
        htmlBody: safeBodyHtml,
        bodyText: safeBodyText,
        bodyHtml: safeBodyHtml,
        headers: safeHeaders,
        links: parsed.links || [],
        linkSnapshots,
        emailType,
        state: 'parsed',
        processingTrace: {
          scan: {
            at: new Date(),
            source: 'scan_inbox'
          }
        }
      },
      $setOnInsert: {
        processedBy: {
          identity_resolver: { done: false, status: 'pending', attempts: 0, version: 'v1' },
          confirmation_runner: { done: false, status: 'pending', attempts: 0, version: 'v1' },
          ingestion_runner: { done: false, status: 'pending', attempts: 0, version: 'v1' }
        }
      }
    },
    { upsert: true, new: true }
  );

  await markEmailActivity({
    gmailMessageId: parsed.id,
    activity: 'metadata_stored',
    parsed,
    emailMessage
  });

  return { emailMessage, senderEmail, senderDomain, emailType };
}

async function processSingleMessage(messageId) {
  const msg = await getMessage(messageId);
  const parsed = parseMessage(msg);
  const { emailMessage, senderEmail, senderDomain, emailType } = await upsertEmailMessage(parsed);
  emailMessage.state = 'typed';

  let brand = await resolveBrand(senderEmail, senderDomain, parsed.links || []);
  let matchSource = 'direct';
  let matchConfidence = 10;
  let candidateBrand = null;
  if (!brand) {
    const inferred = await resolveBrandByContentReference(parsed, senderDomain, emailType);
    if (inferred?.brand) {
      candidateBrand = inferred.brand;
      matchSource = inferred.source || 'content_reference';
      matchConfidence = inferred.confidence || 0;
      logger.info(`[scan_inbox] Content-based brand candidate: "${scrubSensitiveContent(parsed.subject || '')}" -> ${candidateBrand.name} (${matchSource}, confidence=${matchConfidence})`);
      if (matchConfidence >= BRAND_MATCH_CONFIDENCE_THRESHOLD) {
        brand = candidateBrand;
      } else {
        return markUnresolvedForManualReview({
          emailMessage,
          parsed,
          emailType,
          reason: 'low_confidence_match',
          matchSource,
          matchConfidence,
          candidateBrand
        });
      }
    }
  }

  if (!brand) {
    return markUnresolvedForManualReview({
      emailMessage,
      parsed,
      emailType,
      reason: 'no_brand_match',
      matchSource: 'none',
      matchConfidence: 0
    });
  }

  const effectiveEmailType = inferNewsletterLikeType(parsed, emailType, brand);
  if (effectiveEmailType !== emailType) {
    emailMessage.emailType = effectiveEmailType;
  }

  emailMessage.brandId = brand._id;
  emailMessage.state = 'brand_resolved';
  emailMessage.classificationConfidence = matchConfidence;
  emailMessage.classificationReason = matchSource;
  emailMessage.processingTrace = {
    ...(emailMessage.processingTrace || {}),
    resolve: {
      at: new Date(),
      status: 'resolved',
      reason: matchSource,
      confidence: matchConfidence
    }
  };
  emailMessage.processedBy.identity_resolver = {
    done: true,
    at: new Date(),
    version: 'v1',
    attempts: (emailMessage.processedBy?.identity_resolver?.attempts || 0) + 1,
    status: 'done',
    lastProcessedAt: new Date(),
    error: null
  };

  const senderApexDomain = getRegistrableDomain(senderDomain || '') || senderDomain || '';
  if (shouldTrackAsExternalSender(senderDomain, brand.domain)) {
    const listIdDomain = extractListIdDomain(parsed.listId || '');
    const listIdMatchesBrand = !!(listIdDomain && domainsRelated(listIdDomain, brand.domain));
    const linkMatchCount = countDomainMatchInSnapshots(emailMessage.linkSnapshots || [], brand.domain);
    const linkMatchesBrand = linkMatchCount > 0;

    const evidence = upsertExternalSenderEvidence(brand, {
      senderEmail,
      senderDomain,
      senderApexDomain,
      matchSource,
      matchConfidence,
      linkMatchesBrand,
      listIdMatchesBrand
    });
    maybePromoteExternalSenderAlias(brand, evidence, senderEmail, senderApexDomain);
  }

  // Only newsletter emails define the "true" sender identity for a brand.
  if (effectiveEmailType === 'newsletter' &&
      senderEmail &&
      (!brand.currentSenderEmail || brand.currentSenderEmail.toLowerCase() !== senderEmail.toLowerCase())) {
    await brand.recordSenderChange(senderEmail);
  } else if (senderDomain) {
    const senderDomainSet = new Set((brand.knownSenderDomains || []).map((domain) => String(domain).toLowerCase()));
    senderDomainSet.add(senderDomain.toLowerCase());
    senderDomainSet.add(getRegistrableDomain(senderDomain));
    brand.knownSenderDomains = Array.from(senderDomainSet).filter(Boolean);
    brand.currentSenderDomain = brand.currentSenderDomain || senderDomain.toLowerCase();
    brand.primarySenderDomain = brand.primarySenderDomain || senderDomain.toLowerCase();
  }

  brand.lastHealthCheckAt = new Date();
  brand.lastSeenEmailAt = emailMessage.receivedAt || new Date();
  brand.isStale = false;
  brand.totalEmailsReceived = (brand.totalEmailsReceived || 0) + 1;

  if (effectiveEmailType === 'welcome') {
    brand.welcomeEmailReceived = true;
    brand.welcomeEmailReceivedAt = emailMessage.receivedAt;
    brand.welcomeEmailMessageId = messageId;
    brand.confirmationRequired = false;
    const welcomeSet = new Set((brand.welcomeSenderEmails || []).map((email) => String(email).toLowerCase()));
    if (senderEmail) welcomeSet.add(senderEmail.toLowerCase());
    brand.welcomeSenderEmails = Array.from(welcomeSet);
    const trustedByDomain = !!(senderDomain && domainsRelated(senderDomain, brand.domain));
    const trustedByContent = matchSource !== 'direct' && matchConfidence >= 8;
    const shouldMarkSignedUp = trustedByDomain || trustedByContent;
    if (shouldMarkSignedUp) {
      await brand.updateStatus('active', 'Welcome email trusted as signup proof (manual/cowork normalized)');
    } else if (brand.onboardingStatus === 'awaiting_confirmation') {
      brand.statusHistory.push({
        status: brand.onboardingStatus,
        changedAt: new Date(),
        note: 'Welcome email received; waiting for first recurring newsletter sender'
      });
      await brand.save();
    } else if (['failed', 'captcha_blocked', 'discovered', 'submitted', 'subscribing'].includes(brand.onboardingStatus)) {
      await brand.updateStatus('awaiting_confirmation', 'Welcome email received after manual/cowork signup; re-entered workflow');
    } else {
      await brand.save();
    }
  }

  if (effectiveEmailType === 'confirmation') {
    brand.confirmationRequired = true;
    if (['failed', 'captcha_blocked', 'discovered', 'submitted', 'subscribing'].includes(brand.onboardingStatus)) {
      await brand.updateStatus('awaiting_confirmation', 'Confirmation email detected; queued for confirmation processor');
    } else {
      await brand.save();
    }
  }

  if (effectiveEmailType === 'newsletter') {
    if (!brand.firstNewsletterAt) brand.firstNewsletterAt = emailMessage.receivedAt;
    brand.lastNewsletterAt = emailMessage.receivedAt;
    brand.confirmationRequired = false;

    if (brand.onboardingStatus === 'awaiting_confirmation') {
      if (brand.welcomeEmailReceived) {
        await brand.updateStatus('active', 'Newsletter received after welcome; inferred no separate confirmation required');
      } else {
        await brand.updateStatus('active', 'Direct newsletter received without prior welcome/confirmation; inferred subscription is active');
      }
    } else if (brand.onboardingStatus === 'subscribing' || brand.onboardingStatus === 'submitted' || brand.onboardingStatus === 'discovered' || brand.onboardingStatus === 'failed' || brand.onboardingStatus === 'captcha_blocked') {
      await brand.updateStatus('active', 'Direct newsletter received; activated without explicit confirmation step');
    } else {
      await brand.save();
    }
  } else {
    if (!['welcome', 'confirmation'].includes(effectiveEmailType)) {
      await brand.save();
    }
  }

  await emailMessage.save();
  await markEmailActivity({
    gmailMessageId: emailMessage.gmailMessageId,
    activity: 'processed',
    parsed,
    emailMessage
  });
  return {
    matched: true,
    emailType: effectiveEmailType,
    brandId: String(brand._id),
    gmailMessageId: emailMessage.gmailMessageId,
    receivedAt: emailMessage.receivedAt || null
  };
}

async function processInbox({ hours = 24, maxResults = 0 } = {}) {
  const gmail = await getGmailClient();
  const cursor = await loadScanCursor();
  const pageSize = Math.max(1, Math.min(500, Number(process.env.SCAN_PAGE_SIZE || 500)));
  const cap = Math.max(0, Number(maxResults) || 0);
  const fallbackSince = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const since = cursor?.lastCommittedInternalTs
    ? Math.max(0, Math.floor(cursor.lastCommittedInternalTs / 1000) - SCAN_CURSOR_OVERLAP_SECONDS)
    : fallbackSince;
  // Do not require explicit `to:` match; many newsletter ESPs use list aliases/BCC.
  const query = `after:${since} in:inbox`;

  logger.info(`[scan_inbox] Querying Gmail: ${query}`);
  const stats = buildScanStats(0);
  stats.cursor = cursor;

  let pageToken = null;
  let fetchedTotal = 0;

  do {
    if (cap > 0 && fetchedTotal >= cap) {
      stats.truncated = true;
      break;
    }

    const remaining = cap > 0 ? cap - fetchedTotal : pageSize;
    const currentMax = cap > 0 ? Math.min(pageSize, remaining) : pageSize;
    if (currentMax <= 0) break;

    const res = await gmailCall(
      () => gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: currentMax,
        pageToken: pageToken || undefined
      }),
      { label: 'users.messages.list.scan_inbox' }
    );

    const refs = res.data?.messages || [];
    stats.pages += 1;
    stats.fetched += refs.length;
    fetchedTotal += refs.length;

    if (!refs.length) break;
    await processMessageRefs(refs, stats, 'scan_inbox');
    pageToken = res.data?.nextPageToken || null;
  } while (pageToken);

  if (stats.truncated) {
    stats.cursorCommitted = false;
    stats.cursorReason = 'cursor_not_committed_scan_truncated';
  } else if (stats.failed > 0) {
    stats.cursorCommitted = false;
    stats.cursorReason = 'cursor_not_committed_processing_failures_present';
  } else {
    const committed = await commitScanCursor(stats.cursorCandidate, stats);
    stats.cursorCommitted = !!committed;
    stats.cursor = committed || stats.cursor;
  }

  logger.info(`[scan_inbox] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

function buildScanStats(fetched = 0) {
  return {
    fetched,
    pages: 0,
    processed: 0,
    failed: 0,
    truncated: false,
    cursorCommitted: false,
    cursorReason: null,
    cursorCandidate: null,
    cursor: null,
    skippedAlreadyFinalized: 0,
    skippedAlreadyResolved: 0,
    matched: 0,
    unmatched: 0,
    byType: {
      confirmation: 0,
      welcome: 0,
      newsletter: 0,
      transactional: 0,
      other: 0,
      unknown: 0
    }
  };
}

function normalizeCursor(value = null) {
  if (!value || typeof value !== 'object') return null;
  const ts = Number(value.lastCommittedInternalTs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return {
    version: Number(value.version || 1),
    lastCommittedInternalTs: ts,
    lastCommittedAt: value.lastCommittedAt ? new Date(value.lastCommittedAt).toISOString() : null,
    lastCommittedGmailMessageId: value.lastCommittedGmailMessageId ? String(value.lastCommittedGmailMessageId) : null
  };
}

async function loadScanCursor() {
  try {
    const stored = await Config.get(SCAN_CURSOR_CONFIG_KEY);
    return normalizeCursor(stored);
  } catch (err) {
    logger.warn(`[scan_inbox] Failed to load cursor: ${err.message}`);
    return null;
  }
}

function buildCursorCandidate(receivedAt, gmailMessageId) {
  if (!receivedAt) return null;
  const ts = new Date(receivedAt).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return {
    ts,
    gmailMessageId: String(gmailMessageId || '')
  };
}

function isCandidateNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return String(a.gmailMessageId || '') > String(b.gmailMessageId || '');
}

function rememberCursorCandidate(stats, receivedAt, gmailMessageId) {
  const candidate = buildCursorCandidate(receivedAt, gmailMessageId);
  if (!candidate) return;
  if (isCandidateNewer(candidate, stats.cursorCandidate)) {
    stats.cursorCandidate = candidate;
  }
}

async function commitScanCursor(candidate, stats) {
  if (!candidate) {
    stats.cursorReason = 'no_cursor_candidate';
    return null;
  }

  try {
    const existing = await loadScanCursor();
    const existingCandidate = existing
      ? {
          ts: Number(existing.lastCommittedInternalTs || 0),
          gmailMessageId: String(existing.lastCommittedGmailMessageId || '')
        }
      : null;

    if (!isCandidateNewer(candidate, existingCandidate)) {
      stats.cursorReason = 'cursor_already_newer_or_equal';
      return existing;
    }

    const nextCursor = {
      version: 1,
      lastCommittedInternalTs: candidate.ts,
      lastCommittedAt: new Date().toISOString(),
      lastCommittedGmailMessageId: candidate.gmailMessageId || null
    };
    await Config.set(SCAN_CURSOR_CONFIG_KEY, nextCursor);
    stats.cursorReason = 'cursor_committed';
    return nextCursor;
  } catch (err) {
    logger.warn(`[scan_inbox] Failed to commit cursor: ${err.message}`);
    stats.cursorReason = `cursor_commit_failed: ${err.message}`;
    return null;
  }
}

async function processMessageRefs(refs, stats, logPrefix) {
  let loopCount = 0;
  const startedAt = Date.now();
  for (const ref of refs) {
    loopCount += 1;
    try {
      const existing = await EmailMessage.findOne({ gmailMessageId: ref.id })
        .select('processedBy state ingestedAt receivedAt gmailMessageId')
        .lean();
      if (
        existing?.processedBy?.confirmation_runner?.done &&
        (
          !!existing?.ingestedAt ||
          ['ingested', 'finalized'].includes(String(existing?.state || ''))
        )
      ) {
        stats.skippedAlreadyFinalized += 1;
        rememberCursorCandidate(stats, existing?.receivedAt, existing?.gmailMessageId || ref.id);
        continue;
      }
      if (
        existing?.processedBy?.identity_resolver?.done &&
        ['brand_resolved', 'confirmation_processed', 'ingested', 'finalized'].includes(String(existing?.state || ''))
      ) {
        stats.skippedAlreadyResolved += 1;
        rememberCursorCandidate(stats, existing?.receivedAt, existing?.gmailMessageId || ref.id);
        continue;
      }
      const result = await processSingleMessage(ref.id);
      stats.processed += 1;
      rememberCursorCandidate(stats, result?.receivedAt, result?.gmailMessageId || ref.id);
      if (result.matched) stats.matched += 1;
      else stats.unmatched += 1;
      stats.byType[result.emailType] = (stats.byType[result.emailType] || 0) + 1;
      if (loopCount % 25 === 0 || loopCount === refs.length) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.info(`[${logPrefix}] Progress ${loopCount}/${refs.length} (processed=${stats.processed}, matched=${stats.matched}, unmatched=${stats.unmatched}, elapsed=${elapsedSec}s)`);
      }
      await sleep(120);
    } catch (err) {
      stats.failed += 1;
      logger.warn(`[${logPrefix}] Failed to process message ${ref.id}: ${err.message}`);
    }
  }
}

async function processInboxFullHistory({
  maxResults = 0,
  pageSize = 500,
  query = null
} = {}) {
  const gmail = await getGmailClient();
  // Historical migration default should mirror inbox reality, not strict envelope `to:`.
  const baseQuery = String(query || 'in:inbox');
  const safePageSize = Math.max(1, Math.min(500, Number(pageSize) || 500));
  const cap = Math.max(0, Number(maxResults) || 0);
  const stats = buildScanStats(0);

  let pageToken = null;
  let fetchedTotal = 0;

  logger.info(`[scan_inbox_full_history] Querying Gmail from inception: ${baseQuery}`);

  do {
    if (cap > 0 && fetchedTotal >= cap) break;
    const remaining = cap > 0 ? cap - fetchedTotal : safePageSize;
    const currentMax = cap > 0 ? Math.min(safePageSize, remaining) : safePageSize;
    if (currentMax <= 0) break;

    const res = await gmailCall(
      () => gmail.users.messages.list({
        userId: 'me',
        q: baseQuery,
        maxResults: currentMax,
        pageToken: pageToken || undefined
      }),
      { label: 'users.messages.list.full_history' }
    );

    const refs = res.data?.messages || [];
    stats.pages += 1;
    stats.fetched += refs.length;
    fetchedTotal += refs.length;

    if (!refs.length) break;
    logger.info(`[scan_inbox_full_history] Processing page ${stats.pages} with ${refs.length} messages (total fetched: ${fetchedTotal})`);
    await processMessageRefs(refs, stats, 'scan_inbox_full_history');

    pageToken = res.data?.nextPageToken || null;
  } while (pageToken);

  logger.info(`[scan_inbox_full_history] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  processInbox,
  processSingleMessage,
  processInboxFullHistory
};
