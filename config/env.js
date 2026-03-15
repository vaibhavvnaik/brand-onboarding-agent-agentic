const REQUIRED_ENV_VARS = [];

function validateRequiredEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key] || !String(process.env[key]).trim());
  if (missing.length === 0) return;

  const error = new Error(`Missing required environment variables: ${missing.join(', ')}`);
  error.code = 'MISSING_REQUIRED_ENV';
  throw error;
}

module.exports = {
  validateRequiredEnv
};
