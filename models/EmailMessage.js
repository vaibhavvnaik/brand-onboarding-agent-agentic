const mongoose = require('mongoose');

const ProcessorStateSchema = new mongoose.Schema({
  done: { type: Boolean, default: false },
  at: Date,
  version: { type: String, default: 'v1' },
  attempts: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['pending', 'done', 'skipped', 'error'],
    default: 'pending'
  },
  lastProcessedAt: Date,
  error: String
}, { _id: false });

const EmailMessageSchema = new mongoose.Schema({
  gmailMessageId: { type: String, required: true, unique: true },
  gmailThreadHistoryId: String,
  gmailLabelIds: [String],
  gmailSizeEstimate: Number,
  threadId: String,
  from: String,
  fromEmail: String,
  fromDomain: String,
  senderApexDomain: String,
  senderSubdomain: String,
  to: String,
  subject: String,
  snippet: String,
  receivedAt: Date,
  rfc822MessageId: String,
  listUnsubscribe: String,
  listUnsubscribePost: String,
  listId: String,
  precedence: String,
  replyTo: String,
  returnPath: String,
  inReplyTo: String,
  references: String,
  authenticationResults: String,
  espHeaders: { type: mongoose.Schema.Types.Mixed, default: {} },
  attachmentMetadata: { type: [mongoose.Schema.Types.Mixed], default: [] },
  mimeMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
  linkSnapshots: { type: [mongoose.Schema.Types.Mixed], default: [] },
  textBody: String,
  htmlBody: String,
  bodyText: String,
  bodyHtml: String,
  headers: { type: mongoose.Schema.Types.Mixed, default: {} },
  links: [String],

  emailType: {
    type: String,
    enum: ['confirmation', 'welcome', 'newsletter', 'transactional', 'other', 'unknown'],
    default: 'unknown'
  },
  classificationConfidence: Number,
  classificationReason: String,

  state: {
    type: String,
    enum: [
      'discovered',
      'parsed',
      'brand_resolved',
      'brand_unresolved',
      'typed',
      'confirmation_processed',
      'ingested',
      'finalized',
      'error'
    ],
    default: 'discovered'
  },

  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand' },
  needsReview: { type: Boolean, default: false },

  confirmation: {
    required: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'failed', 'not_required'],
      default: 'pending'
    },
    retryCount: { type: Number, default: 0 },
    attempted: { type: Boolean, default: false },
    confirmed: { type: Boolean, default: false },
    clickedAt: Date,
    error: String
  },

  screenshotPath: String,
  ingestedAt: Date,
  processingTrace: { type: mongoose.Schema.Types.Mixed, default: {} },

  processedBy: {
    identity_resolver: { type: ProcessorStateSchema, default: () => ({}) },
    confirmation_runner: { type: ProcessorStateSchema, default: () => ({}) },
    ingestion_runner: { type: ProcessorStateSchema, default: () => ({}) }
  }
}, {
  timestamps: true,
  collection: 'email_messages'
});

EmailMessageSchema.index({ emailType: 1, receivedAt: -1 });
EmailMessageSchema.index({ brandId: 1, receivedAt: -1 });
EmailMessageSchema.index({ rfc822MessageId: 1 });
EmailMessageSchema.index({ senderApexDomain: 1, receivedAt: -1 });
EmailMessageSchema.index({ 'processedBy.identity_resolver.status': 1 });
EmailMessageSchema.index({ 'processedBy.confirmation_runner.status': 1 });
EmailMessageSchema.index({ 'processedBy.ingestion_runner.status': 1 });
EmailMessageSchema.index({ 'processedBy.ingestion_runner.done': 1 });
EmailMessageSchema.index({ 'processedBy.confirmation_runner.done': 1 });

module.exports = mongoose.model('EmailMessage', EmailMessageSchema);
