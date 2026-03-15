/**
 * /setup - Gmail OAuth web setup (no terminal needed)
 * Step 1: Visit /setup/gmail  -> shows auth URL to open
 * Step 2: User opens URL, copies the code, pastes into form
 * Step 3: POST /setup/gmail/exchange  -> saves refresh token to MongoDB
 */
const express = require('express');
const router  = express.Router();
const { getOAuth2Client, saveRefreshToken, getRefreshToken, getOAuthCredentials } = require('../config/gmail');

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

// -- GET /setup -------------------------------------------------
router.get('/', async (req, res) => {
  let gmailConnected = false;
  try { gmailConnected = !!(await getRefreshToken()); } catch (_) {}

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Setup</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="max-w-lg w-full">
    <h1 class="text-2xl font-bold mb-2"> Brand Agent Setup</h1>
    <p class="text-gray-400 mb-8">Complete setup before running the agent from urklist.com.</p>

    <div class="bg-gray-900 rounded-xl p-6 mb-4 border ${gmailConnected ? 'border-green-700' : 'border-yellow-700'}">
      <div class="flex items-center gap-3 mb-3">
        <span class="text-2xl">${gmailConnected ? '[OK]' : '[WARN]'}</span>
        <div>
          <h2 class="font-semibold">Gmail Connection</h2>
          <p class="text-sm text-gray-400">${gmailConnected ? 'Gmail is connected and ready.' : 'Gmail is not yet connected.'}</p>
        </div>
      </div>
      ${!gmailConnected ? `<a href="/setup/gmail" class="block w-full text-center bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2 px-4 rounded-lg transition">Connect Gmail -></a>` : ''}
    </div>

    <div class="bg-gray-900 rounded-xl p-6 border border-gray-700">
      <h2 class="font-semibold mb-1">[OK] MongoDB</h2>
      <p class="text-sm text-gray-400">Connected via MONGODB_URI env var.</p>
    </div>

    <p class="text-center text-gray-500 text-sm mt-8">
      Once setup is complete, visit <strong>urklist.com/admin/brand-agent</strong> to run the agent.
    </p>
  </div>
</body>
</html>`);
});

// -- GET /setup/gmail -------------------------------------------
router.get('/gmail', (req, res) => {
  let oauth2Client;
  let redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
  try {
    ({ redirectUri } = getOAuthCredentials());
    oauth2Client = getOAuth2Client();
  } catch (err) {
    return res.status(500).send(`<p>Error: ${err.message}. Configure Railway env and retry. <a href="/setup">Go back</a></p>`);
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    prompt: 'consent'
  });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Gmail</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="max-w-lg w-full">
    <a href="/setup" class="text-blue-400 text-sm mb-6 inline-block"><- Back to Setup</a>
    <h1 class="text-2xl font-bold mb-2">Connect Gmail</h1>
    <p class="text-gray-400 mb-8">Authorize the agent to read Gmail for newsletter confirmation emails.</p>

    <div class="bg-gray-900 rounded-xl p-6 mb-6 border border-gray-700">
      <h2 class="font-semibold mb-3">Step 1 - Open this link in your browser</h2>
      <a href="${authUrl}" target="_blank"
         class="block w-full text-center bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 px-4 rounded-lg transition mb-3">
         Open Google Authorization ->
      </a>
      <p class="text-xs text-gray-500">Sign in as <strong>${process.env.GMAIL_USER || 'your-newsletter-inbox@example.com'}</strong> and click Allow.</p>
      <p class="text-xs text-gray-500 mt-2">OAuth redirect in use: <code>${redirectUri}</code></p>
    </div>

    <div class="bg-gray-900 rounded-xl p-6 border border-gray-700">
      <h2 class="font-semibold mb-3">Step 2 - Paste the authorization code</h2>
      <form method="POST" action="/setup/gmail/exchange">
        <input name="code" type="text" required
          placeholder="Paste the code from Google here..."
          class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 mb-3 focus:outline-none focus:border-blue-500"
        />
        <button type="submit"
          class="w-full bg-green-600 hover:bg-green-500 text-white font-semibold py-3 px-4 rounded-lg transition">
          [OK] Save & Connect Gmail
        </button>
      </form>
    </div>
  </div>
</body>
</html>`);
});

// -- POST /setup/gmail/exchange ---------------------------------
router.post('/gmail/exchange', async (req, res) => {
  try {
    console.log('[EXCHANGE] POST /setup/gmail/exchange called');
    console.log('[EXCHANGE] req.body:', JSON.stringify(req.body));
    const { code } = req.body || {};
    console.log('[EXCHANGE] code received:', code ? code.substring(0, 20) + '...' : 'NONE');
    if (!code) {
      return res.status(400).send('<p>Error: no code provided. <a href="/setup/gmail">Go back</a></p>');
    }

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code.trim());

    if (!tokens.refresh_token) {
      return res.send(`<!DOCTYPE html>
<html><head><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="max-w-lg text-center">
    <h1 class="text-2xl font-bold text-yellow-400 mb-4">[WARN] No refresh token returned</h1>
    <p class="text-gray-400 mb-6">Google only returns a refresh token on first authorization. Try revoking access and re-authorizing:</p>
    <a href="https://myaccount.google.com/permissions" target="_blank" class="text-blue-400 underline">Revoke access at myaccount.google.com/permissions</a>
    <br><br><a href="/setup/gmail" class="text-blue-400 underline">Try again -></a>
  </div>
</body></html>`);
    }

    await saveRefreshToken(tokens.refresh_token);

    res.send(`<!DOCTYPE html>
<html><head><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="max-w-lg text-center">
    <div class="text-6xl mb-4"></div>
    <h1 class="text-2xl font-bold text-green-400 mb-4">Gmail Connected!</h1>
    <p class="text-gray-400 mb-6">The agent can now read your Gmail inbox to detect newsletter confirmations.</p>
    <a href="/setup" class="bg-green-600 hover:bg-green-500 text-white font-semibold py-3 px-8 rounded-lg transition inline-block">
      <- Back to Setup
    </a>
  </div>
</body></html>`);
  } catch (err) {
    console.error('[EXCHANGE] Error:', err.message, err.stack);
    if (!res.headersSent) {
      const msg = String(err?.message || 'Unknown error');
      if (msg.includes('invalid_client')) {
        return res.status(500).send(
          `<p>Error: invalid_client (Google rejected OAuth client).</p>
<p>Fix in Railway env: set correct <code>GMAIL_CLIENT_ID</code> and <code>GMAIL_CLIENT_SECRET</code> from the same Google OAuth client.</p>
<p>Also ensure redirect URI matches: <code>${process.env.GMAIL_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'}</code>.</p>
<p><a href="/setup/gmail">Go back</a></p>`
        );
      }
      res.status(500).send(`<p>Error: ${msg}. <a href="/setup/gmail">Go back</a></p>`);
    }
  }
});

module.exports = router;
