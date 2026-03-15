/**
 * Brand Discovery Service
 * Sources high-quality D2C brands from milled.com and curated category searches.
 * Scores brands for affiliate potential and quality before returning recommendations.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const Config = require('../models/Config');
const DiscoveryCandidate = require('../models/DiscoveryCandidate');
const logger = require('../utils/logger');
const { createChatCompletion, isLlmAvailable } = require('./llmClient');

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function normalizeDomain(domain = '') {
  return String(domain).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

const DEFAULT_DISCOVERY_EXCLUDED_DOMAINS = [
  // Known low-conversion or anti-bot heavy mega brands; keep discovery focused on sign-up friendly D2C sites.
  'apple.com',
  'tesla.com',
  'nike.com',
  'dyson.com',
  'rimowa.com',
  'chrono24.com'
];

function getDiscoveryExcludedDomains() {
  const envRaw = String(process.env.DISCOVERY_EXCLUDE_DOMAINS || '').trim();
  const envDomains = envRaw
    ? envRaw.split(',').map((value) => normalizeDomain(value)).filter(Boolean)
    : [];
  return new Set([...DEFAULT_DISCOVERY_EXCLUDED_DOMAINS, ...envDomains]);
}

function tierToScore(tier = '') {
  const t = String(tier).toLowerCase();
  if (t === 'luxury') return { quality: 9, affiliate: 8 };
  if (t === 'premium') return { quality: 8, affiliate: 7 };
  if (t === 'established') return { quality: 7, affiliate: 6 };
  if (t === 'emerging') return { quality: 6, affiliate: 5 };
  return { quality: 6, affiliate: 5 };
}

function toPoolScore(brand = {}) {
  const q = Number(brand.qualityScore || 0);
  const a = Number(brand.affiliatePotentialScore || 0);
  return q * 100 + a * 10;
}

function normalizeBrandCandidate(brand = {}) {
  const domain = normalizeDomain(brand.domain || brand.websiteUrl || '');
  if (!domain) return null;
  return {
    domain,
    name: String(brand.name || domain).trim(),
    websiteUrl: String(brand.websiteUrl || `https://www.${domain}`).trim(),
    description: String(brand.description || '').trim(),
    primaryCategory: String(brand.primaryCategory || 'Other').trim(),
    tier: String(brand.tier || brand.brandTier || 'established').toLowerCase(),
    source: String(brand.source || 'ollama_pool'),
    sourceUrl: String(brand.sourceUrl || 'ollama://discovery-pool'),
    qualityScore: Number(brand.qualityScore || 6),
    affiliatePotentialScore: Number(brand.affiliatePotentialScore || 5)
  };
}

async function upsertDiscoveryPoolCandidates(brands = []) {
  const ops = [];
  for (const raw of brands) {
    const item = normalizeBrandCandidate(raw);
    if (!item) continue;
    ops.push({
      updateOne: {
        filter: { domain: item.domain },
        update: {
          $set: {
            name: item.name,
            websiteUrl: item.websiteUrl,
            description: item.description,
            primaryCategory: item.primaryCategory,
            tier: item.tier,
            source: item.source,
            sourceUrl: item.sourceUrl,
            qualityScore: item.qualityScore,
            affiliatePotentialScore: item.affiliatePotentialScore,
            poolScore: toPoolScore(item),
            status: 'queued',
            disabledReason: null
          },
          $setOnInsert: {
            timesServed: 0,
            lastServedAt: null
          }
        },
        upsert: true
      }
    });
  }
  if (!ops.length) return 0;
  const res = await DiscoveryCandidate.bulkWrite(ops, { ordered: false });
  return (res.upsertedCount || 0) + (res.modifiedCount || 0);
}

async function fetchFromDiscoveryPool(limit, existingDomains = new Set()) {
  if (limit <= 0) return [];
  const excluded = Array.from(existingDomains || []).map((d) => normalizeDomain(d)).filter(Boolean);
  const query = {
    status: 'queued',
    domain: excluded.length ? { $nin: excluded } : { $exists: true }
  };
  const rows = await DiscoveryCandidate.find(query)
    .sort({ poolScore: -1, updatedAt: -1, createdAt: 1 })
    .limit(limit)
    .lean();

  if (rows.length) {
    await DiscoveryCandidate.updateMany(
      { _id: { $in: rows.map((row) => row._id) } },
      { $inc: { timesServed: 1 }, $set: { lastServedAt: new Date() } }
    );
  }

  return rows.map((row) => ({
    name: row.name,
    domain: row.domain,
    websiteUrl: row.websiteUrl,
    description: row.description,
    source: row.source || 'ollama_pool',
    sourceUrl: row.sourceUrl || 'ollama://discovery-pool',
    primaryCategory: row.primaryCategory || 'Other',
    tier: row.tier || 'established',
    qualityScore: row.qualityScore || 6,
    affiliatePotentialScore: row.affiliatePotentialScore || 5
  }));
}

async function getDiscoveryPoolStats(existingDomains = new Set()) {
  const excluded = Array.from(existingDomains || []).map((d) => normalizeDomain(d)).filter(Boolean);
  const baseMatch = { status: 'queued' };
  const availableMatch = {
    status: 'queued',
    domain: excluded.length ? { $nin: excluded } : { $exists: true }
  };
  const [queued, available] = await Promise.all([
    DiscoveryCandidate.countDocuments(baseMatch),
    DiscoveryCandidate.countDocuments(availableMatch)
  ]);
  return { queued, available };
}

async function fillDiscoveryPool({
  targetSize = 1000,
  existingDomains = new Set(),
  maxCalls = 8,
  chunkSize = 12,
  highQualityOnly = true
} = {}) {
  const safeTarget = Math.max(50, Math.min(3000, Number(targetSize || 1000)));
  const safeCalls = Math.max(1, Math.min(20, Number(maxCalls || 8)));
  const safeChunk = Math.max(10, Math.min(200, Number(chunkSize || 100)));
  let calls = 0;
  let generated = 0;
  let upserted = 0;
  const generationExclude = new Set(Array.from(existingDomains || []).map((d) => normalizeDomain(d)).filter(Boolean));

  while (calls < safeCalls) {
    const { available } = await getDiscoveryPoolStats(existingDomains);
    if (available >= safeTarget) break;
    const needed = Math.min(safeChunk, safeTarget - available);
    const batch = await discoverBrandsWithLlm(needed, generationExclude, {
      useHistoryFilter: false,
      highQualityOnly
    });
    calls += 1;
    generated += batch.length;
    if (!batch.length) break;
    upserted += await upsertDiscoveryPoolCandidates(batch);
    for (const item of batch) generationExclude.add(normalizeDomain(item.domain));
    await sleep(350);
  }

  const stats = await getDiscoveryPoolStats(existingDomains);
  return { calls, generated, upserted, ...stats, targetSize: safeTarget };
}

async function discoverBrandsWithLlm(limit, existingDomains = new Set(), options = {}) {
  if (!isLlmAvailable()) {
    logger.warn('[discovery] LLM discovery skipped: LLM not configured');
    return [];
  }

  const hardMaxReturn = Math.max(1, Math.min(12, parseInt(process.env.DISCOVERY_LLM_MAX_RETURN || '4', 10)));
  const requestedLimit = Math.max(1, Math.min(hardMaxReturn, parseInt(limit || 1, 10)));
  const useHistoryFilter = options.useHistoryFilter !== false;
  const highQualityOnly = options.highQualityOnly !== false;
  const history = useHistoryFilter
    ? (await Config.get('llm_discovery_domains').catch(() => null))
      || (await Config.get('claude_discovery_domains').catch(() => null))
      || []
    : [];
  const blocked = new Set([
    ...Array.from(existingDomains || []).map((d) => normalizeDomain(d)),
    ...history.map((d) => normalizeDomain(d)),
    ...Array.from(getDiscoveryExcludedDomains())
  ]);

  const avoidListMax = Math.max(20, parseInt(process.env.DISCOVERY_AVOID_LIST_MAX || '60', 10));
  const avoidList = Array.from(blocked).filter(Boolean).slice(-avoidListMax);
  const prompt = `Return exactly ${requestedLimit} real D2C ecommerce brands as JSON only.

JSON array schema:
[{"name":"","domain":"","websiteUrl":"","primaryCategory":"","brandTier":"","reason":""}]

Rules:
- domain must be root only (no path, no www)
- exclude marketplaces/publishers/software tools
- reason max 6 words
- keep values short and concise
- prioritize highest quality D2C brands first
- prefer premium, luxury, or established brands
- avoid low-quality / dropship-style brands
- ${highQualityOnly ? 'if uncertain, return only premium/luxury/established tiers' : 'allow mixed tiers when needed'}
- do not include these domains: ${avoidList.join(', ') || '(none)'}
`;

  let results = [];
  try {
    const response = await createChatCompletion({
      phase: 'discovery',
      maxTokens: Math.max(140, Math.min(320, 120 + requestedLimit * 40)),
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = (response.text || '').trim();
    const jsonBlock = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const start = jsonBlock.indexOf('[');
    const end = jsonBlock.lastIndexOf(']');
    const jsonStr = start >= 0 && end > start ? jsonBlock.slice(start, end + 1) : jsonBlock;
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return [];

    const seen = new Set();
    const allowedTiers = highQualityOnly ? new Set(['premium', 'luxury', 'established']) : null;
    for (const item of arr) {
      const name = String(item?.name || '').trim();
      const domain = normalizeDomain(item?.domain || item?.websiteUrl || '');
      const tier = String(item?.brandTier || 'established').trim().toLowerCase();
      if (!name || !domain) continue;
      if (blocked.has(domain) || seen.has(domain)) continue;
      if (allowedTiers && !allowedTiers.has(tier)) continue;
      seen.add(domain);
      const websiteUrl = item?.websiteUrl ? String(item.websiteUrl).trim() : `https://www.${domain}`;
      const { quality, affiliate } = tierToScore(tier);
      results.push({
        name,
        domain,
        websiteUrl,
        description: String(item?.reason || '').trim(),
        source: 'ollama_ai',
        sourceUrl: 'ollama://brand-discovery',
        primaryCategory: String(item?.primaryCategory || 'Other').trim(),
        tier,
        qualityScore: quality,
        affiliatePotentialScore: affiliate
      });
      if (results.length >= requestedLimit) break;
    }
  } catch (err) {
    logger.warn(`[discovery] LLM discovery failed: ${err.message}`);
    return [];
  }

  if (results.length && useHistoryFilter) {
    try {
      const updatedHistory = Array.from(new Set([...history, ...results.map((r) => r.domain)])).slice(-1500);
      await Config.set('llm_discovery_domains', updatedHistory);
    } catch (err) {
      logger.warn(`[discovery] LLM history persistence failed, continuing with fresh results: ${err.message}`);
    }
  }
  logger.info(`[discovery] LLM generated ${results.length} candidate brands`);
  return results;
}

// -- Milled.com Category Mapping --------------------------------
// Maps our categories to milled.com's search terms
const MILLED_SEARCH_TERMS = [
  { category: 'Fashion & Apparel',        query: 'fashion clothing apparel',  priority: 1 },
  { category: 'Beauty & Skincare',        query: 'beauty skincare cosmetics', priority: 1 },
  { category: 'Health & Wellness',        query: 'health wellness vitamins',  priority: 1 },
  { category: 'Home & Living',            query: 'home decor furniture',      priority: 2 },
  { category: 'Food & Beverage',          query: 'food beverage snacks',      priority: 2 },
  { category: 'Fitness & Sports',         query: 'fitness sports activewear', priority: 1 },
  { category: 'Outdoor & Adventure',      query: 'outdoor adventure camping', priority: 2 },
  { category: 'Tech & Gadgets',           query: 'tech gadgets electronics',  priority: 2 },
  { category: 'Sustainable & Eco',        query: 'sustainable eco organic',   priority: 1 },
  { category: 'Baby & Kids',              query: 'baby kids children',        priority: 3 },
  { category: 'Pets',                     query: 'pet dog cat animals',       priority: 3 },
  { category: 'Travel & Luggage',         query: 'travel luggage bags',       priority: 3 },
  { category: 'Jewelry & Watches',        query: 'jewelry watches accessories',priority: 2 },
  { category: 'Personal Care & Grooming', query: 'grooming personal care men',priority: 2 },
  { category: 'Gifts & Novelty',          query: 'gifts novelty unique',      priority: 3 },
];

// -- Quality Scoring Heuristics ---------------------------------
const HIGH_VALUE_KEYWORDS = [
  'premium', 'luxury', 'sustainable', 'organic', 'handmade', 'artisan',
  'direct', 'brand', 'shop', 'store', 'collection', 'co', 'studio',
  'lab', 'supply', 'goods', 'craft', 'design', 'wear', 'living'
];

const LOW_VALUE_INDICATORS = [
  'aliexpress', 'dhgate', 'alibaba', 'wish', 'teemu', 'shein', 'fashion nova',
  'wholesale', 'dropship', 'cheap', 'discount', 'coupon', 'deal', 'outlet'
];

// Known high-quality D2C brands to seed the pipeline
const SEED_BRANDS = [
  // Fashion & Apparel
  { name: 'Allbirds',       domain: 'allbirds.com',       category: 'Fashion & Apparel',    tier: 'premium' },
  { name: 'Everlane',       domain: 'everlane.com',       category: 'Fashion & Apparel',    tier: 'premium' },
  { name: 'Reformation',    domain: 'thereformation.com', category: 'Sustainable & Eco',    tier: 'premium' },
  { name: 'Patagonia',      domain: 'patagonia.com',      category: 'Outdoor & Adventure',  tier: 'established' },
  { name: 'Vuori',          domain: 'vuoriclothing.com',  category: 'Fitness & Sports',     tier: 'premium' },
  { name: 'Cotopaxi',       domain: 'cotopaxi.com',       category: 'Outdoor & Adventure',  tier: 'emerging' },
  { name: 'Buck Mason',     domain: 'buckmason.com',      category: 'Fashion & Apparel',    tier: 'premium' },
  { name: 'Quince',         domain: 'quince.com',         category: 'Fashion & Apparel',    tier: 'established' },
  // Beauty & Skincare
  { name: 'Glossier',       domain: 'glossier.com',       category: 'Beauty & Skincare',    tier: 'established' },
  { name: 'ILIA Beauty',    domain: 'iliabeauty.com',     category: 'Beauty & Skincare',    tier: 'premium' },
  { name: 'Tatcha',         domain: 'tatcha.com',         category: 'Beauty & Skincare',    tier: 'luxury' },
  { name: 'Tower 28',       domain: 'tower28beauty.com',  category: 'Beauty & Skincare',    tier: 'emerging' },
  { name: 'Drunk Elephant', domain: 'drunkelephant.com',  category: 'Beauty & Skincare',    tier: 'premium' },
  { name: 'Necessaire',     domain: 'necessaire.com',     category: 'Personal Care & Grooming', tier: 'premium' },
  { name: 'Olaplex',        domain: 'olaplex.com',        category: 'Beauty & Skincare',    tier: 'established' },
  // Health & Wellness
  { name: 'Athletic Greens', domain: 'athleticgreens.com', category: 'Health & Wellness',   tier: 'established' },
  { name: 'Seed Health',    domain: 'seed.com',            category: 'Health & Wellness',   tier: 'emerging' },
  { name: 'Ritual',         domain: 'ritual.com',          category: 'Health & Wellness',   tier: 'established' },
  { name: 'Thrive Market',  domain: 'thrivemarket.com',    category: 'Food & Beverage',     tier: 'established' },
  { name: 'Magic Spoon',    domain: 'magicspoon.com',      category: 'Food & Beverage',     tier: 'emerging' },
  // Home & Living
  { name: 'Floyd Home',     domain: 'floydhome.com',      category: 'Home & Living',        tier: 'emerging' },
  { name: 'Parachute Home', domain: 'parachutehome.com',  category: 'Home & Living',        tier: 'established' },
  { name: 'Brooklinen',     domain: 'brooklinen.com',     category: 'Home & Living',        tier: 'established' },
  { name: 'Brightland',     domain: 'brightland.com',     category: 'Food & Beverage',      tier: 'premium' },
  { name: 'Year & Day',     domain: 'yearandday.com',     category: 'Home & Living',        tier: 'emerging' },
  // Tech & Gadgets
  { name: 'Oura Ring',      domain: 'ouraring.com',       category: 'Tech & Gadgets',       tier: 'premium' },
  { name: 'Whoop',          domain: 'whoop.com',          category: 'Fitness & Sports',     tier: 'established' },
  { name: 'Peak Design',    domain: 'peakdesign.com',     category: 'Tech & Gadgets',       tier: 'premium' },
  { name: 'Bellroy',        domain: 'bellroy.com',        category: 'Travel & Luggage',     tier: 'premium' },
  // Jewelry & Watches
  { name: 'Mejuri',         domain: 'mejuri.com',         category: 'Jewelry & Watches',    tier: 'premium' },
  { name: 'Studs',          domain: 'studs.com',          category: 'Jewelry & Watches',    tier: 'emerging' },
  { name: 'AUrate',         domain: 'auratenewyork.com',  category: 'Jewelry & Watches',    tier: 'premium' },
  // Sustainable
  { name: 'Girlfriend Collective', domain: 'girlfriend.com', category: 'Sustainable & Eco', tier: 'established' },
  { name: 'Pela Case',      domain: 'pelacase.com',       category: 'Sustainable & Eco',   tier: 'emerging' },
  { name: 'Tentree',        domain: 'tentree.com',        category: 'Sustainable & Eco',   tier: 'established' },
  // Pets
  { name: 'Wild One',       domain: 'wildone.com',        category: 'Pets',                 tier: 'emerging' },
  { name: 'BarkBox',        domain: 'barkbox.com',        category: 'Pets',                 tier: 'established' },
  // Gifts & Novelty
  { name: 'Uncommon Goods', domain: 'uncommongoods.com',  category: 'Gifts & Novelty',     tier: 'established' },
  { name: 'Greetabl',       domain: 'greetabl.com',       category: 'Gifts & Novelty',     tier: 'emerging' },
];

// -----------------------------------------------------------------

/**
 * Scrape milled.com for brands in a specific category/search.
 * Returns array of raw brand objects.
 */
async function scrapeMilledSearch(searchTerm, maxResults = 30) {
  const brands = [];
  let blockedBy403 = false;
  try {
    const url = `https://milled.com/search?q=${encodeURIComponent(searchTerm)}&type=senders`;
    logger.info(`Scraping milled.com: "${searchTerm}"`);

    const res = await axios.get(url, { headers: BASE_HEADERS, timeout: 15000 });
    const $ = cheerio.load(res.data);

    // Milled.com brand result cards
    $('div.content-list-item, .sender-item, article[data-sender]').each((i, el) => {
      if (brands.length >= maxResults) return false;

      const $el = $(el);

      const name = $el.find('.content-list-item-name, .sender-name, h3').first().text().trim();
      const profileLink = $el.find('a[href*="/"]').first().attr('href');
      const domain = profileLink
        ? profileLink.replace(/^\//, '').split('/')[0]
        : null;

      const frequency = $el.find('.frequency, .send-frequency').text().trim();
      const tags = [];
      $el.find('.tag, .category-tag, .label').each((_, t) => tags.push($(t).text().trim()));

      if (name && name.length > 1) {
        brands.push({
          name,
          milledSlug: profileLink ? profileLink.replace(/^\//, '') : null,
          milledFrequency: frequency || null,
          milledIndustrialTags: tags,
          source: 'milled.com',
          sourceUrl: url
        });
      }
    });

    // Alternative scraping for different milled.com page structure
    if (brands.length === 0) {
      $('a[href^="/"]').each((i, el) => {
        if (brands.length >= maxResults) return false;
        const $el = $(el);
        const href = $el.attr('href') || '';
        const text = $el.text().trim();

        // Milled brand pages are /{brand-slug}
        if (href.split('/').length === 2 && text.length > 2 && text.length < 60 &&
            !href.includes('search') && !href.includes('page') && !href.includes('.')) {
          brands.push({
            name: text,
            milledSlug: href.replace('/', ''),
            source: 'milled.com',
            sourceUrl: url
          });
        }
      });
    }

    logger.info(`Found ${brands.length} brands for "${searchTerm}"`);
  } catch (err) {
    if (Number(err?.response?.status) === 403) blockedBy403 = true;
    logger.warn(`Milled.com scrape failed for "${searchTerm}": ${err.message}`);
  }
  return { brands, blockedBy403 };
}

/**
 * Get detailed brand info from milled.com brand page.
 * Enriches a brand with domain, website, frequency, etc.
 */
async function scrapeMilledBrandPage(milledSlug) {
  try {
    const url = `https://milled.com/${milledSlug}`;
    const res = await axios.get(url, { headers: BASE_HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);

    // Extract website link
    const websiteLink = $('a[href*="://"]').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return !href.includes('milled.com') && href.startsWith('http');
    }).first().attr('href');

    let domain = null;
    if (websiteLink) {
      try {
        domain = new URL(websiteLink).hostname.replace(/^www\./, '');
      } catch { /* ignore */ }
    }

    const description = $('meta[name="description"]').attr('content') ||
                        $('.sender-description, .brand-description').first().text().trim();

    const frequency = $('.frequency-count, .send-count').first().text().trim();
    const tags = [];
    $('.industry-tag, .category-badge').each((_, el) => tags.push($(el).text().trim()));

    return { domain, websiteUrl: websiteLink, description, milledFrequency: frequency, milledIndustrialTags: tags };
  } catch {
    return {};
  }
}

/**
 * Check if a brand has a real website we can sign up to.
 */
async function validateBrandWebsite(websiteUrl) {
  try {
    const res = await axios.get(websiteUrl, {
      headers: BASE_HEADERS,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

/**
 * Score a brand for quality and affiliate potential.
 * Returns a score 1-10 based on heuristics (AI scoring happens in brandCategorizer).
 */
function scoreBrand(brand) {
  let score = 5; // Base score

  const nameLower = (brand.name || '').toLowerCase();
  const descLower = (brand.description || '').toLowerCase();
  const combined  = nameLower + ' ' + descLower;

  // Downgrade low-quality indicators
  if (LOW_VALUE_INDICATORS.some(kw => combined.includes(kw))) score -= 3;

  // Upgrade for known quality signals
  if (HIGH_VALUE_KEYWORDS.some(kw => combined.includes(kw))) score += 1;

  // Frequency signals: brands that send regularly are more engaged
  const freq = (brand.milledFrequency || '').toLowerCase();
  if (freq.includes('week')) score += 1;
  if (freq.includes('daily')) score += 0.5;
  if (freq.includes('month')) score += 0;

  // Tier from seed data
  const tier = brand.tier;
  if (tier === 'luxury')      score += 2;
  if (tier === 'premium')     score += 1.5;
  if (tier === 'established') score += 1;
  if (tier === 'emerging')    score += 0.5;

  // Has tags from milled = more data = more established brand
  if ((brand.milledIndustrialTags || []).length > 2) score += 0.5;

  return Math.min(10, Math.max(1, Math.round(score)));
}

/**
 * Main discovery function - returns up to `limit` scored, unique brands.
 * @param {number} limit - Max number of brands to discover
 * @param {Object} existingDomains - Set of already-onboarded domains to skip
 */
async function discoverBrands(limit = 20, existingDomains = new Set()) {
  logger.info(`\n Starting brand discovery - target: ${limit} brands`);
  const discovered = new Map(); // domain -> brand object, to deduplicate
  const excludedDomains = getDiscoveryExcludedDomains();
  const discoverySourceRaw = String(process.env.DISCOVERY_SOURCE || 'ollama').toLowerCase();
  const discoverySource = discoverySourceRaw === 'claude' ? 'ollama' : discoverySourceRaw;
  const strictLlm = String(process.env.DISCOVERY_STRICT_LLM || process.env.DISCOVERY_STRICT_CLAUDE || 'false').toLowerCase() === 'true';
  const forceLlmPath = envFlag('DISCOVERY_FORCE_LLM_PATH', true);
  const allowLegacyFallback = envFlag('DISCOVERY_ALLOW_LEGACY_FALLBACK', false);
  const poolEnabled = envFlag('DISCOVERY_POOL_ENABLED', true);
  const poolTargetSize = Math.max(100, parseInt(process.env.DISCOVERY_POOL_TARGET_SIZE || '1000', 10));
  const poolFillChunkSize = Math.max(10, parseInt(process.env.DISCOVERY_POOL_FILL_BATCH || '12', 10));
  const poolMaxCallsPerRun = Math.max(1, parseInt(process.env.DISCOVERY_POOL_MAX_CALLS_PER_RUN || '3', 10));
  const poolRefillThreshold = Math.max(limit, parseInt(process.env.DISCOVERY_POOL_REFILL_THRESHOLD || '100', 10));
  const poolRefillOnExhaust = envFlag('DISCOVERY_POOL_REFILL_ON_EXHAUST', true);
  const poolRefillBurstMaxCalls = Math.max(1, parseInt(process.env.DISCOVERY_POOL_REFILL_BURST_MAX_CALLS || '120', 10));
  const poolHighQualityOnly = envFlag('DISCOVERY_POOL_HIGH_QUALITY_ONLY', true);
  const llmConfigured = isLlmAvailable();
  const sourceRequestsLegacy = ['legacy', 'milled_only'].includes(discoverySource);
  const useLlm = forceLlmPath ? true : !sourceRequestsLegacy;
  const allowFallback = allowLegacyFallback && (discoverySource !== 'ollama_only' || !strictLlm);

  if (forceLlmPath && sourceRequestsLegacy) {
    logger.warn(`[discovery] DISCOVERY_SOURCE=${discoverySource} ignored because DISCOVERY_FORCE_LLM_PATH=true`);
  }

  if (useLlm) {
    if (!llmConfigured) {
      logger.warn('[discovery] LLM not configured; using fallback discovery sources');
    }
    if (poolEnabled) {
      const initialPoolStats = await getDiscoveryPoolStats(existingDomains);
      const needsExhaustRefill = poolRefillOnExhaust && initialPoolStats.available < limit;
      const belowThreshold = initialPoolStats.available < poolRefillThreshold;
      const shouldRefill = needsExhaustRefill || belowThreshold;

      if (shouldRefill && llmConfigured) {
        const refillTarget = needsExhaustRefill
          ? Math.max(poolTargetSize, initialPoolStats.available + 1000)
          : poolTargetSize;
        const neededForTarget = Math.max(0, refillTarget - initialPoolStats.available);
        const computedCalls = neededForTarget > 0 ? Math.ceil(neededForTarget / poolFillChunkSize) : 0;
        const maxCalls = needsExhaustRefill
          ? Math.min(poolRefillBurstMaxCalls, Math.max(poolMaxCallsPerRun, computedCalls))
          : poolMaxCallsPerRun;

        const fillStats = await fillDiscoveryPool({
          targetSize: refillTarget,
          existingDomains,
          maxCalls,
          chunkSize: poolFillChunkSize,
          highQualityOnly: poolHighQualityOnly
        });
        logger.info(`[discovery_pool] queued=${fillStats.queued} available=${fillStats.available} target=${fillStats.targetSize} calls=${fillStats.calls} generated=${fillStats.generated} exhaust_refill=${needsExhaustRefill}`);
      } else if (shouldRefill) {
        logger.warn('[discovery_pool] refill skipped: llm not configured');
      } else {
        logger.info(`[discovery_pool] skip_refill=true available=${initialPoolStats.available} threshold=${poolRefillThreshold} limit=${limit}`);
      }

      const pooled = await fetchFromDiscoveryPool(limit, existingDomains);
      for (const brand of pooled) {
        const cleanDomain = normalizeDomain(brand.domain);
        if (!cleanDomain || existingDomains.has(cleanDomain) || discovered.has(cleanDomain) || excludedDomains.has(cleanDomain)) continue;
        discovered.set(cleanDomain, brand);
      }
    }

    if (discovered.size < limit) {
      const missing = limit - discovered.size;
      const llmBrands = await discoverBrandsWithLlm(missing, existingDomains, {
        useHistoryFilter: true,
        highQualityOnly: poolHighQualityOnly
      });
      for (const brand of llmBrands) {
        const cleanDomain = normalizeDomain(brand.domain);
        if (!cleanDomain || existingDomains.has(cleanDomain) || discovered.has(cleanDomain) || excludedDomains.has(cleanDomain)) continue;
        discovered.set(cleanDomain, brand);
      }
      if (poolEnabled && llmBrands.length) {
        await upsertDiscoveryPoolCandidates(llmBrands);
      }
    }

    if (discovered.size >= limit) {
      const result = Array.from(discovered.values()).slice(0, limit);
      logger.info(`[OK] Discovery complete (LLM/Pool): returning ${result.length} brands`);
      return result;
    }
    if (!allowFallback) {
      const result = Array.from(discovered.values()).slice(0, limit);
      logger.info(`[OK] Discovery complete (LLM-only): returning ${result.length} brands`);
      return result;
    }
  }

  if (!allowFallback) {
    logger.warn('[discovery] Legacy fallback disabled; returning only LLM/pool results');
    const result = Array.from(discovered.values()).slice(0, limit);
    logger.info(`[OK] Discovery complete (no-fallback): returning ${result.length} brands`);
    return result;
  }

  // -- 1. Start with curated seed brands ------------------------
  logger.info('Loading curated seed brands...');
  for (const brand of SEED_BRANDS) {
    const cleanDomain = brand.domain.replace(/^www\./, '').toLowerCase();
    if (!existingDomains.has(cleanDomain) && !discovered.has(cleanDomain) && !excludedDomains.has(cleanDomain)) {
      discovered.set(cleanDomain, {
        ...brand,
        websiteUrl: `https://www.${brand.domain}`,
        source: 'curated_seed',
        qualityScore: scoreBrand(brand),
        affiliatePotentialScore: brand.tier === 'luxury' ? 8 :
                                  brand.tier === 'premium' ? 7 :
                                  brand.tier === 'established' ? 6 : 5
      });
    }
  }
  logger.info(`Loaded ${discovered.size} seed brands`);
  // -- 2. Milled fallback intentionally disabled -----------------
  logger.info('[discovery] Milled scraping fallback disabled by policy');

  // -- 3. Sort by quality score and return top N -----------------
  const all = Array.from(discovered.values());
  all.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

  const result = all.slice(0, limit);
  logger.info(`[OK] Discovery complete: returning ${result.length} brands`);
  return result;
}

module.exports = {
  discoverBrands,
  scrapeMilledBrandPage,
  validateBrandWebsite,
  fillDiscoveryPool,
  getDiscoveryPoolStats
};
