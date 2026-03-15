const mongoose = require('mongoose');
let ActivityLogModel = null;

function getActivityModel() {
  if (!ActivityLogModel) {
    // Lazy load to avoid cyclic initialization issues during boot.
    // eslint-disable-next-line global-require
    ActivityLogModel = require('../models/ActivityLog');
  }
  return ActivityLogModel;
}

async function appendActivityLog(entry = {}) {
  try {
    if (mongoose.connection.readyState !== 1) return;
    const ActivityLog = getActivityModel();
    await ActivityLog.create({
      source: entry.source || 'runtime',
      level: entry.level || 'info',
      phase: entry.phase || 'general',
      message: String(entry.message || '').slice(0, 2000),
      meta: entry.meta || null
    });
  } catch {
    // Never break runtime flow on logging failure.
  }
}

module.exports = { appendActivityLog };
