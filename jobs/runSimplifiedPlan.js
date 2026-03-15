require('dotenv').config();

const { connectDB } = require('../config/database');
const { runJob } = require('./runJob');

async function runSimplifiedPlan(options = {}) {
  const normalizedOptions = {
    ...options,
    hours: Number(options.inboxHours ?? options.hours ?? process.env.SCAN_HOURS ?? 24),
    maxResults: Number(options.maxInboxResults ?? options.maxResults ?? process.env.SCAN_MAX_RESULTS ?? 0)
  };
  const result = {
    startedAt: new Date().toISOString(),
    discover_and_signup: null,
    recover_failed_signups: null,
    scan_inbox: null,
    process_confirmations: null,
    ingest_newsletters: null,
    completedAt: null
  };

  result.discover_and_signup = await runJob('discover_and_signup', normalizedOptions);
  result.recover_failed_signups = await runJob('recover_failed_signups', normalizedOptions);
  result.scan_inbox = await runJob('scan_inbox', normalizedOptions);
  result.process_confirmations = await runJob('process_confirmations', normalizedOptions);
  result.ingest_newsletters = await runJob('ingest_newsletters', normalizedOptions);
  result.completedAt = new Date().toISOString();

  return result;
}

if (require.main === module) {
  connectDB()
    .then(() => runSimplifiedPlan())
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { runSimplifiedPlan };
