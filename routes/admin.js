const express  = require('express');
const router   = express.Router();
const path     = require('path');
const { requireAuth, attemptLogin } = require('../middleware/auth');

// -- Login page -------------------------------------------------
router.get('/login', (req, res) => {
  const error = req.query.error ? 'Invalid email or password' : '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>urklist - Sign In</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);min-height:100vh;}</style>
</head>
<body class="flex items-center justify-center min-h-screen">
  <div class="w-full max-w-sm">
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold text-white tracking-tight">urklist</h1>
      <p class="text-slate-400 mt-2 text-sm">Brand Intelligence Dashboard</p>
    </div>
    <div class="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-8 shadow-2xl">
      ${error ? `<div class="mb-4 p-3 bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 text-sm">${error}</div>` : ''}
      <form method="POST" action="/dashboard/login" class="space-y-4">
        <div>
          <label class="block text-slate-300 text-sm font-medium mb-1.5">Email</label>
          <input type="email" name="email" required autofocus
            class="w-full px-4 py-2.5 bg-white/10 border border-white/20 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            placeholder="admin@urklist.com">
        </div>
        <div>
          <label class="block text-slate-300 text-sm font-medium mb-1.5">Password</label>
          <input type="password" name="password" required
            class="w-full px-4 py-2.5 bg-white/10 border border-white/20 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            placeholder="********">
        </div>
        <button type="submit"
          class="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg transition-colors">
          Sign In ->
        </button>
      </form>
    </div>
  </div>
</body>
</html>`);
});

// -- Login POST -------------------------------------------------
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = attemptLogin(email, password);

  if (!user) return res.redirect('/dashboard/login?error=1');

  req.session.user = user;
  const returnTo = req.session.returnTo || '/dashboard';
  delete req.session.returnTo;
  res.redirect(returnTo);
});

// -- Logout -----------------------------------------------------
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/dashboard/login');
});

// -- Main Dashboard ---------------------------------------------
router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

// -- Session user info (for frontend) --------------------------
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

module.exports = router;
