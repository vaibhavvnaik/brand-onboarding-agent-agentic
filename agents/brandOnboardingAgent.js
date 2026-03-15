/**
 * Brand Onboarding Agent - Main Orchestrator
 * Now accepts onProgress callback for live web streaming.
 */
const Brand = require('../models/Brand');
const { discoverBrands } = require('../services/brandDiscovery');
const { signUpForNewsletter } = require('../services/newsletterSignup');
const { categorizeBrand, categorizeBrands } = require('../services/brandCategorizer');
const { ensureBrandLogo } = require('../services/brandLogo');
const { filterDuplicates } = require('../services/duplicateChecker');
const { scanRecentEmails, detectStaleBrands } = require('../services/emailChangeDetector');
const { classifySignupFailure } = require('../utils/signupFailure');
const { ensurePlaywrightRuntimeReady } = require('../utils/runtimePreflight');
const { enqueueSignupRecoveryTask } = require('../services/signupRecovery');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SIGNUP_DELAY = parseInt(process.env.SIGNUP_DELAY_MS || '4000');

// -- Programmatic entry point -----------------------------------
async function run({ batchSize = 10, mode = 'full', onProgress = () => {}, getStopFlag = () => false } = {}) {
  const emit = (level, phase, message, extra = {}) => {
    onProgress({ level, phase, message, ...extra });
    logger.info(`[${phase}] ${message}`);
  };
  switch (mode) {
    case 'full':
    case 'discover_and_signup':
      return runFullOnboarding(batchSize, emit, getStopFlag);
    case 'discover':    return runDiscoveryOnly(batchSize, emit);
    case 'scan_emails': return runEmailScan(emit);
    case 'stale_check': return runStaleCheck(emit);
    default:            return runFullOnboarding(batchSize, emit, getStopFlag);
  }
}

// -- Full pipeline ----------------------------------------------
async function runFullOnboarding(batchSize, emit, getStopFlag) {
  const startTime = Date.now();
  const stats = {
    discovered: 0,
    duplicatesSkipped: 0,
    signupSuccess: 0,
    signupFailed: 0,
    confirmed: 0,
    categorized: 0,
    runtimeReady: true
  };

  emit('info', 'discovery', ` Phase 1: Discovering brands (target: ${batchSize})...`);
  const existingBrands  = await Brand.find({}, 'domain').lean();
  const existingDomains = new Set(existingBrands.map(b => b.domain.toLowerCase()));
  const discovered = await discoverBrands(batchSize, existingDomains);
  stats.discovered = discovered.length;
  emit('info', 'discovery', ` Scraped ${discovered.length} candidates from sources`);

  const { unique, duplicates } = await filterDuplicates(discovered);
  stats.duplicatesSkipped = duplicates.length;
  emit('success', 'discovery', `[OK] ${unique.length} unique brands ready (${duplicates.length} duplicates skipped)`);
  const toOnboard = unique;
  emit('info', 'categorization', ` Phase 2: AI categorizing ${toOnboard.length} brands...`);
  const categorizationResults = new Map();
  const existingByDomain = new Map(
    (await Brand.find({ domain: { $in: toOnboard.map((brand) => brand.domain) } })
      .select('domain primaryCategory categories tags lifestyleTags targetDemographic productTypes priceRange brandTier audienceSize genderFocus businessModel qualityScore affiliatePotentialScore affiliateNetworks hasAffiliateProgram estimatedRevShare description')
      .lean())
      .map((doc) => [String(doc.domain || '').toLowerCase(), doc])
  );

  const aiQueue = [];
  for (const brand of toOnboard) {
    const existing = existingByDomain.get(String(brand.domain || '').toLowerCase());
    if (existing?.primaryCategory && existing?.qualityScore && existing?.affiliatePotentialScore) {
      categorizationResults.set(brand.domain, existing);
      stats.categorized++;
      emit('info', 'categorization', `    ${brand.name} -> ${existing.primaryCategory} (cached)`);
    } else {
      aiQueue.push(brand);
    }
  }

  if (aiQueue.length) {
    const batchResults = await categorizeBrands(aiQueue);
    for (const result of batchResults) {
      if (getStopFlag()) { emit('warn', 'stop', ' Stopped by user'); return stats; }
      if (result.success) {
        categorizationResults.set(result.brand.domain, result.data);
        stats.categorized++;
        emit('info', 'categorization', `    ${result.brand.name} -> ${result.data.primaryCategory || 'uncategorized'}`);
      } else {
        // Safety fallback for individual failures in a batch call path.
        const fallback = await categorizeBrand(result.brand);
        if (fallback.success) {
          categorizationResults.set(result.brand.domain, fallback.data);
          stats.categorized++;
          emit('info', 'categorization', `    ${result.brand.name} -> ${fallback.data.primaryCategory || 'uncategorized'}`);
        }
      }
    }
  }
  emit('success', 'categorization', `[OK] Categorized ${stats.categorized} brands`);
  emit('info', 'signup', ` Phase 3: Signing up for ${toOnboard.length} newsletters...`);

  const runtime = await ensurePlaywrightRuntimeReady({ autoInstall: true });
  if (!runtime.ready) {
    stats.runtimeReady = false;
    emit('error', 'signup', `[ERR] Runtime preflight failed before signup phase: ${runtime.reason || 'unknown reason'}`);
    throw new Error(`signup_runtime_preflight_failed: ${runtime.reason || 'unknown reason'}`);
  }

  for (let i = 0; i < toOnboard.length; i++) {
    if (getStopFlag()) { emit('warn', 'stop', ' Stopped by user'); break; }
    const brand   = toOnboard[i];
    const catData = categorizationResults.get(brand.domain) || {};
    emit('info', 'signup', `[${i + 1}/${toOnboard.length}]  ${brand.name} (${brand.domain})`);
    let brandDoc = await Brand.findOne({ domain: brand.domain });
    if (!brandDoc) {
      brandDoc = new Brand({
        name: brand.name, domain: brand.domain, websiteUrl: brand.websiteUrl,
        source: brand.source || 'curated_seed', sourceUrl: brand.sourceUrl,
        description: catData.description || brand.description,
        primaryCategory: catData.primaryCategory, categories: catData.categories || [],
        tags: catData.tags || [], lifestyleTags: catData.lifestyleTags || [],
        targetDemographic: catData.targetDemographic || [], productTypes: catData.productTypes || [],
        priceRange: catData.priceRange, brandTier: catData.brandTier,
        audienceSize: catData.audienceSize, genderFocus: catData.genderFocus,
        businessModel: catData.businessModel,
        qualityScore: catData.qualityScore, affiliatePotentialScore: catData.affiliatePotentialScore,
        affiliateNetworks: catData.affiliateNetworks || [], hasAffiliateProgram: catData.hasAffiliateProgram || false,
        estimatedRevShare: catData.estimatedRevShare,
        milledFrequency: brand.milledFrequency, milledIndustrialTags: brand.milledIndustrialTags || [],
        onboardingStatus: 'subscribing',
        statusHistory: [{ status: 'discovered', note: 'Agent' }, { status: 'subscribing', note: 'Starting signup' }]
      });
    } else {
      brandDoc.onboardingStatus = 'subscribing';
    }

    if (!brandDoc.logoUrl) {
      try {
        const logo = await ensureBrandLogo({
          websiteUrl: brandDoc.websiteUrl,
          domain: brandDoc.domain,
          name: brandDoc.name,
          currentLogoUrl: brandDoc.logoUrl
        });
        if (logo?.ok && logo.logoUrl) {
          brandDoc.logoUrl = logo.logoUrl;
          emit('info', 'metadata', `    ${brand.name}: logo captured`);
        }
      } catch (err) {
        logger.debug(`[metadata] logo capture skipped for ${brand.name}: ${err.message}`);
      }
    }

    await brandDoc.save();
    const signupResult = await signUpForNewsletter(brand.websiteUrl, brand.name);
    brandDoc.signupAttempts      = (brandDoc.signupAttempts || 0) + 1;
    brandDoc.lastSignupAttempt   = new Date();
    brandDoc.signupAttemptLog    = brandDoc.signupAttemptLog || [];
    brandDoc.signupAttemptLog.push({
      attemptedAt: new Date(), formUrl: signupResult.formUrl || brand.websiteUrl,
      espDetected: signupResult.espProvider, strategy: signupResult.strategy,
      outcome: signupResult.success ? 'success' : 'failed',
      errorMessage: signupResult.error,
      failureCategory: signupResult.failureCategory || null,
      failureCode: signupResult.failureCode || null,
      diagnostic: signupResult.attemptTrace || null
    });
    if (signupResult.espProvider && signupResult.espProvider !== 'unknown') brandDoc.espProvider = signupResult.espProvider;
    if (signupResult.formUrl) brandDoc.signupFormUrl = signupResult.formUrl;
    if (!signupResult.success) {
      stats.signupFailed++;
      const reason = signupResult.error || 'Unknown';
      const classified = classifySignupFailure(reason, signupResult.strategy);
      const status = classified.category === 'captcha_blocked' ? 'captcha_blocked' : 'failed';
      brandDoc.signupError = reason;
      brandDoc.signupFailureCategory = signupResult.failureCategory || classified.category;
      brandDoc.signupFailureCode = signupResult.failureCode || classified.code;
      brandDoc.signupFailureAt = new Date();
      brandDoc.signupFailureScreenshotPath = signupResult.failureScreenshotPath || null;
      brandDoc.signupFailureDiagnostic = {
        websiteUrl: brand.websiteUrl,
        attemptedStrategy: signupResult.strategy || null,
        attemptTrace: signupResult.attemptTrace || [],
        espProvider: signupResult.espProvider || 'unknown'
      };
      await brandDoc.updateStatus(status, `Signup failed: ${reason}`);
      try {
        await enqueueSignupRecoveryTask({ brand: brandDoc, signupResult });
        emit('info', 'recovery', `    ${brand.name}: queued for automatic signup recovery`);
      } catch (queueErr) {
        logger.warn(`[signup_recovery] Failed to enqueue task for ${brand.name}: ${queueErr.message}`);
      }
      emit('warn', 'signup', `  [ERR] ${brand.name}: ${reason}`);
      await sleep(SIGNUP_DELAY);
      continue;
    }
    brandDoc.signupError = null;
    brandDoc.signupFailureCategory = null;
    brandDoc.signupFailureCode = null;
    brandDoc.signupFailureAt = null;
    brandDoc.signupFailureScreenshotPath = null;
    brandDoc.signupFailureDiagnostic = null;
    stats.signupSuccess++;
    emit('success', 'signup', `  [OK] ${brand.name}: submitted (${signupResult.strategy})`);
    await brandDoc.updateStatus('awaiting_confirmation', 'Waiting for async inbox worker');

    emit('info', 'confirmation', `  [...] ${brand.name}: queued for async confirmation processing`);
    if (i < toOnboard.length - 1) await sleep(SIGNUP_DELAY + Math.floor(Math.random() * 2000));
  }
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  emit('success', 'summary',
    ` Finished in ${duration}min - [OK] ${stats.signupSuccess} signups, [OK] ${stats.confirmed} confirmed, [ERR] ${stats.signupFailed} failed`,
    { stats }
  );
  return stats;
}

async function runDiscoveryOnly(batchSize, emit) {
  emit('info', 'discovery', ` Discovery only - ${batchSize} brands`);
  const existingDomains = new Set((await Brand.find({}, 'domain').lean()).map(b => b.domain));
  const brands = await discoverBrands(batchSize, existingDomains);
  const { unique } = await filterDuplicates(brands);
  unique.forEach((b, i) => emit('info', 'discovery', `  ${i + 1}. ${b.name} - ${b.domain}`));
  emit('success', 'discovery', `[OK] ${unique.length} unique brands found`);
  return unique;
}

async function runEmailScan(emit) {
  emit('info', 'email_scan', ' Scanning last 24h of emails...');
  const result = await scanRecentEmails(24);
  emit('success', 'email_scan', `[OK] ${result.processed} brand emails, ${result.senderChanges} sender changes`);
  return result;
}

async function runStaleCheck(emit) {
  emit('info', 'stale_check', '  Checking for stale brands (no emails in 60d)...');
  const count = await detectStaleBrands(60);
  emit('success', 'stale_check', `[OK] Marked ${count} brands as stale`);
  return { staleCount: count };
}

module.exports = { run };
