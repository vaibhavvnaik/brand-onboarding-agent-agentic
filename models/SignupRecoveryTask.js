const mongoose = require('mongoose');

const SignupRecoveryTaskSchema = new mongoose.Schema({
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
  brandName: { type: String, required: true },
  domain: { type: String, required: true, index: true },
  websiteUrl: { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'resolved', 'failed'],
    default: 'pending',
    index: true
  },
  source: {
    type: String,
    enum: ['signup_failure', 'manual'],
    default: 'signup_failure'
  },
  failureCategory: String,
  failureCode: String,
  lastError: String,
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  assignedTo: { type: String, default: 'agent' },
  coworkPrompt: String,
  context: { type: mongoose.Schema.Types.Mixed, default: null },
  resolvedAt: Date,
  lastTriedAt: Date
}, {
  timestamps: true,
  collection: 'signup_recovery_tasks'
});

SignupRecoveryTaskSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('SignupRecoveryTask', SignupRecoveryTaskSchema);
