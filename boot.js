// boot.js - Entry point that fixes encoding before starting the app
// Uses execSync to run fix-encoding.js as a child process
// This ensures all source files are cleaned before any require() calls
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function applyRuntimeEnv() {
  const libPaths = [
    path.join(__dirname, '.local-libs/usr/lib/x86_64-linux-gnu'),
    path.join(__dirname, '.local-libs/lib/x86_64-linux-gnu')
  ].filter((p) => fs.existsSync(p));

  if (libPaths.length) {
    const existing = process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : [];
    const merged = [...libPaths, ...existing.filter(Boolean)];
    process.env.LD_LIBRARY_PATH = Array.from(new Set(merged)).join(':');
  }

  // Keep browser binaries local to the project so build/deploy artifacts are deterministic.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  }
}

console.log('boot.js: Starting encoding fix...');
applyRuntimeEnv();
console.log('boot.js: Runtime env prepared (LD_LIBRARY_PATH + PLAYWRIGHT_BROWSERS_PATH).');
try {
  execSync('node ' + path.join(__dirname, 'fix-encoding.js'), {
    stdio: 'inherit',
    cwd: __dirname
  });
  console.log('boot.js: Encoding fix completed. Starting app...');
} catch (err) {
  console.error('boot.js: Encoding fix failed:', err.message);
  console.log('boot.js: Attempting to start app anyway...');
}

// Now require the main app (files should be fixed at this point)
require('./index');
