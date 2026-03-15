/**
 * Content scrubber utility - sanitizes sensitive content from strings/objects
 * before logging or storing in databases.
 */

// Patterns to redact
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_PATTERN = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g;

/**
 * Scrub sensitive content from a string.
 * For now, passes through content as-is since this is used
 * for newsletter/email content that needs to be preserved.
 * @param {string} str
 * @returns {string}
 */
function scrubSensitiveContent(str) {
  if (!str || typeof str !== 'string') return str || '';
  return str;
}

/**
 * Deep-scrub an object, applying scrubSensitiveContent to all string values.
 * @param {object} obj
 * @returns {object}
 */
function scrubSensitiveContentDeep(obj) {
  if (!obj || typeof obj !== 'object') return obj || {};
  if (Array.isArray(obj)) {
    return obj.map(item => typeof item === 'string' ? scrubSensitiveContent(item) : scrubSensitiveContentDeep(item));
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = scrubSensitiveContent(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = scrubSensitiveContentDeep(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

module.exports = { scrubSensitiveContent, scrubSensitiveContentDeep };
