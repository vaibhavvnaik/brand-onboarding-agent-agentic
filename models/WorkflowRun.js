const mongoose = require('mongoose');

const WorkflowRunSchema = new mongoose.Schema(
  {
    step: {
      type: String,
      enum: [
        'discover_and_signup',
        'scan_inbox',
        'scan_inbox_full_history',
        'process_confirmations',
        'ingest_newsletters',
        'recover_failed_signups',
        'retry_missing_screenshots',
        'retake_screenshots',
        'backfill_listings',
        'link_legacy_listings_to_emails',
        'scrub_sensitive_content',
        'backfill_gmail_labels',
        'run_simplified_cycle',
        'run_agentic_cycle',
        'resume_agentic_cycle'
      ],
      required: true
    },
    trigger: {
      type: String,
      enum: ['api', 'cli', 'scheduler'],
      default: 'api'
    },
    status: {
      type: String,
      enum: ['running', 'success', 'failed'],
      default: 'running'
    },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
    durationMs: Number,
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    error: String,
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

WorkflowRunSchema.index({ step: 1, startedAt: -1 });
WorkflowRunSchema.index({ startedAt: -1 });

module.exports = mongoose.model('WorkflowRun', WorkflowRunSchema);
