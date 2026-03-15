const mongoose = require('mongoose');

const ActivityLogSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ['runtime', 'api_agent', 'job'],
      default: 'runtime'
    },
    level: {
      type: String,
      enum: ['debug', 'info', 'warn', 'error', 'success'],
      default: 'info'
    },
    phase: { type: String, default: 'general' },
    message: { type: String, required: true, trim: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

ActivityLogSchema.index({ createdAt: -1 });
ActivityLogSchema.index({ source: 1, createdAt: -1 });
ActivityLogSchema.index({ phase: 1, createdAt: -1 });
ActivityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model('ActivityLog', ActivityLogSchema);
