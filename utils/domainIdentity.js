function normalizeDomain(domain = '') {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

const COMPOUND_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au',
  'co.in', 'firm.in', 'net.in', 'org.in',
  'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'net.br', 'org.br',
  'co.nz', 'org.nz'
]);

function getRegistrableDomain(domain = '') {
  const clean = normalizeDomain(domain);
  if (!clean) return '';
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  const last3 = `${parts[parts.length - 3]}.${last2}`;
  if (COMPOUND_PUBLIC_SUFFIXES.has(last2) && parts.length >= 3) return last3;
  return last2;
}

function domainsRelated(a = '', b = '') {
  const aa = normalizeDomain(a);
  const bb = normalizeDomain(b);
  if (!aa || !bb) return false;
  if (aa === bb) return true;
  if (aa.endsWith(`.${bb}`) || bb.endsWith(`.${aa}`)) return true;
  return getRegistrableDomain(aa) === getRegistrableDomain(bb);
}

function extractDomainFromUrl(url = '') {
  try {
    return normalizeDomain(new URL(String(url)).hostname);
  } catch {
    return '';
  }
}

module.exports = {
  normalizeDomain,
  getRegistrableDomain,
  domainsRelated,
  extractDomainFromUrl
};
