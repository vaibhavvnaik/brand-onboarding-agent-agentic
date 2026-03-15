/**
 * Duplicate Checker
 * Guards against onboarding the same brand twice using domain matching,
 * name fuzzy matching, and known alias patterns.
 */
const Brand = require('../models/Brand');
const logger = require('../utils/logger');

/**
 * Check if a brand already exists in the database.
 * Returns { isDuplicate, existingBrand, matchReason }
 */
async function checkForDuplicate(name, domain, websiteUrl) {
  const cleanDomain = normalizeDomain(domain || extractDomainFromUrl(websiteUrl));

  if (!cleanDomain) {
    return { isDuplicate: false, existingBrand: null, matchReason: null };
  }

  // -- 1. Exact domain match -------------------------------------
  const domainMatch = await Brand.findOne({
    domain: { $regex: new RegExp(`^(www\\.)?${escapeRegex(cleanDomain)}$`, 'i') }
  });
  if (domainMatch) {
    return { isDuplicate: true, existingBrand: domainMatch, matchReason: 'exact_domain' };
  }

  // -- 2. Root domain match (handles subdomains like shop.brand.com vs brand.com) --
  const rootDomain = getRootDomain(cleanDomain);
  if (rootDomain !== cleanDomain) {
    const rootMatch = await Brand.findOne({
      domain: { $regex: new RegExp(`${escapeRegex(rootDomain)}$`, 'i') }
    });
    if (rootMatch) {
      return { isDuplicate: true, existingBrand: rootMatch, matchReason: 'subdomain_of_existing' };
    }
  }

  // -- 3. Name fuzzy match (catch "Nike" vs "Nike Inc" vs "Nike.com") --
  if (name) {
    const cleanName = normalizeName(name);
    const nameMatch = await Brand.findOne({
      name: { $regex: new RegExp(escapeRegex(cleanName), 'i') }
    });
    if (nameMatch && normalizeDomain(nameMatch.domain).includes(rootDomain)) {
      return { isDuplicate: true, existingBrand: nameMatch, matchReason: 'fuzzy_name_match' };
    }
  }

  return { isDuplicate: false, existingBrand: null, matchReason: null };
}

/**
 * Filter a list of brand candidates, removing any that are duplicates.
 * Returns { unique: [], duplicates: [] }
 */
async function filterDuplicates(brands) {
  const unique     = [];
  const duplicates = [];
  const seenDomains = new Set(); // Also deduplicate within the batch itself

  for (const brand of brands) {
    const domain = normalizeDomain(brand.domain || extractDomainFromUrl(brand.websiteUrl));

    // Check within batch
    if (seenDomains.has(domain)) {
      duplicates.push({ brand, matchReason: 'duplicate_in_batch' });
      continue;
    }
    seenDomains.add(domain);

    // Check against DB
    const { isDuplicate, existingBrand, matchReason } = await checkForDuplicate(brand.name, domain, brand.websiteUrl);
    if (isDuplicate) {
      logger.info(`  [WARN]  Skipping duplicate: ${brand.name} (${matchReason} -> ${existingBrand.name})`);
      duplicates.push({ brand, existingBrand, matchReason });
    } else {
      unique.push(brand);
    }
  }

  return { unique, duplicates };
}

// -- Helpers ----------------------------------------------------

function normalizeDomain(domain) {
  if (!domain) return '';
  return domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '').toLowerCase().trim();
}

function extractDomainFromUrl(url) {
  if (!url) return '';
  try { return new URL(url).hostname; } catch { return ''; }
}

function getRootDomain(domain) {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join('.');
}

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/\.(com|net|org|co|io)$/i, '')
    .replace(/\b(inc|llc|ltd|co|company|the)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { checkForDuplicate, filterDuplicates };
