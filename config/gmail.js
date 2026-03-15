/**
 * Gmail API - loads refresh token from env OR from MongoDB (set via /setup/gmail web flow).
 */
const { google } = require('googleapis');
const logger = require('../utils/logger');

let _gmailClient = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label = 'gmail_request_timeout') {
  const timeoutMs = Math.max(1000, Number(ms) || 20000);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label);
      err.code = 'GMAIL_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function gmailCall(executor, {
  label = 'gmail_call',
  timeoutMs = Number(process.env.GMAIL_REQUEST_TIMEOUT_MS || 20000),
  retries = Number(process.env.GMAIL_REQUEST_RETRIES || 2)
} = {}) {
  const maxRetries = Math.max(0, Number(retries) || 0);
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await withTimeout(executor(), timeoutMs, `${label}_timeout`);
    } catch (err) {
      lastErr = err;
      const status = Number(err?.response?.status || 0);
      const retryable = err?.code === 'GMAIL_TIMEOUT' || status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries) break;
      const backoffMs = 500 * (attempt + 1);
      logger.warn(`[gmail] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying in ${backoffMs}ms...`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

function getOAuthCredentials() {
  const clientId = String(process.env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GMAIL_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.GMAIL_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob').trim();

  if (!clientId || !clientSecret) {
    throw new Error('Missing Gmail OAuth credentials. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.');
  }
  return { clientId, clientSecret, redirectUri };
}

async function getRefreshTokenFromDb() {
  try {
    const Config = require('../models/Config');
    const token = await Config.get('gmail_refresh_token');
    return token || null;
  } catch (_) {
    return null;
  }
}

function getRefreshTokenFromEnv() {
  if (process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_REFRESH_TOKEN !== 'FILL_IN_AFTER_RUNNING_SETUP') {
    return process.env.GMAIL_REFRESH_TOKEN;
  }
  return null;
}

async function getRefreshToken() {
  return getRefreshTokenFromEnv() || await getRefreshTokenFromDb();
}

function getAuthErrorDetail(err) {
  const payload = err?.response?.data || err?.errors?.[0] || null;
  const error = payload?.error || err?.code || 'unknown';
  const description = payload?.error_description || err?.message || 'unknown auth error';
  return `${error}: ${description}`;
}

async function saveRefreshToken(token) {
    // Cache in-memory immediately so this process can use it right away
    process.env.GMAIL_REFRESH_TOKEN = token;
    _gmailClient = null;
    // Try to persist to MongoDB; log token prominently if DB is unavailable
    try {
          const Config = require('../models/Config');
          await Config.set('gmail_refresh_token', token);
          logger.info('[OK] Gmail refresh token saved to database');
    } catch (dbErr) {
          logger.warn('[WARN] MongoDB unavailable  token NOT persisted to DB.');
          logger.warn('[ACTION REQUIRED] Set in Railway dashboard: GMAIL_REFRESH_TOKEN=' + token);
    }
}

function getOAuth2Client(refreshToken) {
  const { clientId, clientSecret, redirectUri } = getOAuthCredentials();
  const client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function getGmailClient() {
  if (_gmailClient) return _gmailClient;
  const envToken = getRefreshTokenFromEnv();
  const dbToken = await getRefreshTokenFromDb();
  const candidates = [
    { source: 'db', token: dbToken },
    { source: 'env', token: envToken }
  ].filter((row) => row.token);

  if (!candidates.length) throw new Error('No Gmail token configured. Visit /setup/gmail to connect Gmail.');

  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const auth = getOAuth2Client(candidate.token);
      const gmail = google.gmail({ version: 'v1', auth });
      await gmailCall(
        () => gmail.users.getProfile({ userId: 'me' }),
        { label: 'users.getProfile' }
      );
      _gmailClient = gmail;
      logger.info(`[OK] Gmail API connected for ${process.env.GMAIL_USER} (token_source=${candidate.source})`);
      if (candidate.source === 'db' && process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_REFRESH_TOKEN !== candidate.token) {
        logger.warn('[gmail] Env refresh token appears stale; DB token succeeded. Update/remove GMAIL_REFRESH_TOKEN env var.');
      }
      return _gmailClient;
    } catch (err) {
      lastErr = err;
      logger.error(`[ERR] Gmail API auth failed (token_source=${candidate.source}): ${getAuthErrorDetail(err)}`);
    }
  }
  _gmailClient = null;
  throw lastErr || new Error('Gmail authentication failed');
}

async function searchMessages(query, maxResults = 20) {
  const gmail = await getGmailClient();
  const res = await gmailCall(
    () => gmail.users.messages.list({ userId: 'me', q: query, maxResults }),
    { label: 'users.messages.list' }
  );
  return res.data.messages || [];
}

async function getMessage(messageId) {
  const gmail = await getGmailClient();
  const res = await gmailCall(
    () => gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' }),
    { label: 'users.messages.get' }
  );
  return res.data;
}

function getHeaderValue(headers = [], key = '') {
  const wanted = String(key || '').toLowerCase();
  const row = (headers || []).find((h) => String(h?.name || '').toLowerCase() === wanted);
  return row?.value || '';
}

function parseCharset(contentType = '') {
  const match = String(contentType || '').match(/charset="?([^";\s]+)"?/i);
  return match ? match[1].toLowerCase() : '';
}

function collectEspHeaders(rawHeaders = {}) {
  const out = {};
  const keys = Object.keys(rawHeaders || {});
  const interesting = [
    'x-mailer',
    'feedback-id',
    'x-campaign',
    'x-mailchimp',
    'x-mc-',
    'x-klaviyo',
    'x-sg-',
    'x-ses-',
    'x-sendgrid',
    'x-postmark',
    'x-customerio',
    'x-ctct'
  ];
  for (const key of keys) {
    const low = key.toLowerCase();
    if (interesting.some((prefix) => low === prefix || low.startsWith(prefix))) {
      out[low] = rawHeaders[key];
    }
  }
  return out;
}

function parseMessage(msg) {
  const headers = {};
  (msg.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });
  const bodyParts = [];
  const attachments = [];
  const mimeTypes = [];
  const charsets = new Set();

  function extractParts(part, partPath = '0') {
    if (!part) return;
    const mimeType = part.mimeType || 'text/plain';
    const partHeaders = part.headers || [];
    const contentType = getHeaderValue(partHeaders, 'content-type');
    const contentDisposition = getHeaderValue(partHeaders, 'content-disposition');
    const contentId = getHeaderValue(partHeaders, 'content-id');
    const charset = parseCharset(contentType);
    if (charset) charsets.add(charset);
    mimeTypes.push(mimeType);

    if (part.body?.data) {
      bodyParts.push({
        mimeType,
        content: Buffer.from(part.body.data, 'base64').toString('utf8')
      });
    }

    const hasAttachment = Boolean(part?.body?.attachmentId || part?.filename);
    if (hasAttachment) {
      attachments.push({
        partPath,
        filename: part.filename || '',
        mimeType,
        size: Number(part?.body?.size || 0),
        attachmentId: part?.body?.attachmentId || null,
        contentId: contentId || null,
        contentDisposition: contentDisposition || null,
        inline: /inline/i.test(contentDisposition)
      });
    }

    (part.parts || []).forEach((child, index) => extractParts(child, `${partPath}.${index}`));
  }
  extractParts(msg.payload, '0');
  const htmlPart = bodyParts.find(p => p.mimeType === 'text/html');
  const links = [];
  if (htmlPart) {
    const hrefRegex = /href=["']([^"']+)["']/gi; let match;
    while ((match = hrefRegex.exec(htmlPart.content)) !== null) {
      const url = match[1].trim();
      if (url.startsWith('http') && !url.includes('unsubscribe') && !url.includes('mailto:') && url.length < 500) links.push(url);
    }
  }
  return {
    id: msg.id, threadId: msg.threadId, from: headers['from'] || '', to: headers['to'] || '',
    subject: headers['subject'] || '', date: headers['date'] || '',
    rawHeaders: headers,
    messageId: headers['message-id'] || '',
    listUnsubscribe: headers['list-unsubscribe'] || '',
    listUnsubscribePost: headers['list-unsubscribe-post'] || '',
    listId: headers['list-id'] || '',
    precedence: headers['precedence'] || '',
    replyTo: headers['reply-to'] || '',
    returnPath: headers['return-path'] || '',
    inReplyTo: headers['in-reply-to'] || '',
    references: headers.references || '',
    authenticationResults: headers['authentication-results'] || '',
    espHeaders: collectEspHeaders(headers),
    historyId: msg.historyId || '',
    labelIds: msg.labelIds || [],
    sizeEstimate: msg.sizeEstimate || 0,
    attachments,
    mimeMeta: {
      topMimeType: msg?.payload?.mimeType || '',
      partCount: mimeTypes.length,
      htmlPartCount: bodyParts.filter((p) => p.mimeType === 'text/html').length,
      textPartCount: bodyParts.filter((p) => p.mimeType === 'text/plain').length,
      attachmentCount: attachments.length,
      mimeTypes: Array.from(new Set(mimeTypes)),
      charsets: Array.from(charsets)
    },
    bodyText: bodyParts.find(p => p.mimeType === 'text/plain')?.content || '',
    bodyHtml: htmlPart?.content || '', links: [...new Set(links)],
    snippet: msg.snippet || '', internalDate: msg.internalDate
  };
}

function extractSenderEmail(fromHeader) {
  if (!fromHeader) return null;
  const match = fromHeader.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase().trim();
  const plain = fromHeader.trim().toLowerCase();
  return plain.includes('@') ? plain : null;
}

function extractDomainFromEmail(email) {
  if (!email) return null;
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

module.exports = {
  getGmailClient,
  getOAuth2Client,
  getRefreshToken,
  saveRefreshToken,
  gmailCall,
  searchMessages,
  getMessage,
  parseMessage,
  extractSenderEmail,
  extractDomainFromEmail,
  getOAuthCredentials
};
