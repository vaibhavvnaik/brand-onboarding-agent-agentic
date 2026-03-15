/**
 * Authentication middleware for the brand dashboard.
 * Admin users are defined in .env as: ADMIN_USERS=email:password,email2:password2
 */

// Parse admin users from environment at startup
function parseAdminUsers() {
  const raw = process.env.ADMIN_USERS || '';
  const users = {};
  raw.split(',').forEach(pair => {
    const [email, password] = pair.trim().split(':');
    if (email && password) users[email.toLowerCase()] = password;
  });
  return users;
}

const ADMIN_USERS = parseAdminUsers();

/**
 * Middleware: require authenticated session for dashboard routes.
 * Redirects to login if not authenticated.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/dashboard/login');
}

/**
 * Middleware: require authenticated session for API routes.
 * Returns 401 JSON instead of redirect.
 * Accepts:
 *   1. Session cookie (logged-in dashboard user)
 *   2. Bearer <admin-password>  (legacy)
 *   3. Bearer <AGENT_API_KEY>   (urklist.com server-side calls)
 */
function requireApiAuth(req, res, next) {
  // Check session auth
  if (req.session && req.session.user) return next();

  // Accept x-api-key header for cron/scheduler callers
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey && process.env.API_KEY && xApiKey === process.env.API_KEY) {
    return next();
  }

  // Accept Bearer token
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);

    if (process.env.API_KEY && token === process.env.API_KEY) {
      return next();
    }

    // Accept AGENT_API_KEY (shared secret with urklist.com)
    const agentApiKey = process.env.AGENT_API_KEY;
    if (agentApiKey && token === agentApiKey) {
      return next();
    }

    // Accept admin passwords
    const validTokens = Object.values(ADMIN_USERS);
    if (validTokens.includes(token)) {
      return next();
    }
  }

  return res.status(401).json({ error: 'Unauthorized', message: 'Please log in at /dashboard/login' });
}

/**
 * Attempt login with email + password.
 * Returns user object on success, null on failure.
 */
function attemptLogin(email, password) {
  const emailLower = (email || '').toLowerCase().trim();
  const stored = ADMIN_USERS[emailLower];
  if (stored && stored === password) {
    return { email: emailLower, role: 'admin' };
  }
  return null;
}

module.exports = { requireAuth, requireApiAuth, attemptLogin };
