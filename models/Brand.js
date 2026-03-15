const mongoose = require('mongoose');
const { normalizeDomain, getRegistrableDomain } = require('../utils/domainIdentity');

// --- Sender Email History (track address changes over time) ---
const SenderEmailHistorySchema = new mongoose.Schema({
  email:       { type: String, required: true },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now },
  reason:      { type: String, enum: ['initial', 'change_detected', 'manual'], default: 'initial' }
}, { _id: false });

// --- Sample Email ----------------------------------------------
const SampleEmailSchema = new mongoose.Schema({
  subject:    String,
  receivedAt: Date,
  messageId:  String,
  type:       { type: String, enum: ['welcome', 'confirmation', 'newsletter', 'promotional', 'other'] }
}, { _id: false });

// --- Sign-up Attempt Log ---------------------------------------
const SignupAttemptSchema = new mongoose.Schema({
  attemptedAt:    { type: Date, default: Date.now },
  formUrl:        String,
  espDetected:    String,
  strategy:       String, // 'footer_form', 'popup', 'dedicated_page', 'esp_api'
  outcome:        { type: String, enum: ['success', 'failed', 'captcha', 'already_subscribed', 'timeout'] },
  errorMessage:   String,
  failureCategory: String,
  failureCode: String,
  diagnostic: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

// --- External Sender Evidence (ESP alias tracking) --------------
const ExternalSenderEvidenceSchema = new mongoose.Schema({
  senderEmail: { type: String, required: true, lowercase: true, trim: true },
  senderDomain: { type: String, lowercase: true, trim: true },
  senderApexDomain: { type: String, lowercase: true, trim: true },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  evidenceCount: { type: Number, default: 1 },
  linkMatchesBrandDomainCount: { type: Number, default: 0 },
  listIdMatchesBrandCount: { type: Number, default: 0 },
  highConfidenceMatchCount: { type: Number, default: 0 },
  lastMatchSource: String,
  lastMatchConfidence: Number,
  promotedEmailAt: Date,
  promotedDomainAt: Date,
  reviewStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  reviewedAt: Date,
  reviewNotes: String
}, { _id: false });

// --- Main Brand Schema -----------------------------------------
const BrandSchema = new mongoose.Schema({

  // -- Identity -------------------------------------------------
  name:         { type: String, required: true, trim: true },
  domain:       { type: String, required: true, trim: true, lowercase: true },
  websiteUrl:   { type: String, required: true },
  logoUrl:      String,
  description:  String,
  tagline:      String,

  // -- Subscription ---------------------------------------------
  subscriptionEmail:   {
    type: String,
    default: () => process.env.GMAIL_USER || 'newsletter@example.com'
  },
  currentSenderEmail:  String,   // The FROM address brand uses to send newsletters
  primarySenderEmail:  String,
  currentSenderDomain: String,
  primarySenderDomain: String,
  knownSenderEmails:   [{ type: String, lowercase: true, trim: true }],
  knownSenderDomains:  [{ type: String, lowercase: true, trim: true }],
  externalSenderEvidence: [ExternalSenderEvidenceSchema],
  welcomeSenderEmails: [{ type: String, lowercase: true, trim: true }],
  senderEmailHistory:  [SenderEmailHistorySchema],
  signupFormUrl:       String,   // Exact URL where form was located
  espProvider:         {         // Email Service Provider detected
    type: String,
    enum: ['klaviyo', 'mailchimp', 'sendgrid', 'omnisend', 'privy', 'drip',
           'activecampaign', 'hubspot', 'brevo', 'constantcontact', 'convertkit',
           'attentive', 'postscript', 'yotpo', 'iterable', 'sfmc', 'other', 'unknown'],
    default: 'unknown'
  },

  // -- Onboarding Status -----------------------------------------
  onboardingStatus: {
    type: String,
    enum: ['discovered', 'submitted', 'subscribing', 'awaiting_confirmation', 'confirmed',
           'active', 'failed', 'stale', 'duplicate', 'skipped', 'captcha_blocked'],
    default: 'discovered'
  },
  statusUpdatedAt:  Date,
  statusHistory: [{
    status:    String,
    changedAt: { type: Date, default: Date.now },
    note:      String
  }],

  // -- Email Activity ---------------------------------------------
  welcomeEmailReceived:   { type: Boolean, default: false },
  welcomeEmailMessageId:  String,
  welcomeEmailReceivedAt: Date,
  confirmationRequired:   { type: Boolean, default: false },
  confirmationSentAt:     Date,
  signupConfirmedAt:      Date,
  firstNewsletterAt:      Date,
  lastNewsletterAt:       Date,
  lastSeenEmailAt:        Date,
  totalEmailsReceived:    { type: Number, default: 0 },
  newsletterFrequency:    String, // e.g. 'daily', '2x_week', 'weekly', 'biweekly', 'monthly'
  sampleEmails:           [SampleEmailSchema],
  sampleSubjectLines:     [String], // First 5 subject lines captured
  unsubscribeUrl:         String,
  affiliateSignupUrl:     String,  // Detected affiliate program link

  // -- Signup Attempt Tracking ------------------------------------
  signupAttempts:     { type: Number, default: 0 },
  signupAttemptLog:   [SignupAttemptSchema],
  lastSignupAttempt:  Date,
  signupError:        String,
  signupFailureCategory: String,
  signupFailureCode: String,
  signupFailureAt: Date,
  signupFailureScreenshotPath: String,
  signupFailureDiagnostic: { type: mongoose.Schema.Types.Mixed, default: null },

  // -- AI Categorization ------------------------------------------
  primaryCategory: {
    type: String,
    enum: [
      'Fashion & Apparel', 'Beauty & Skincare', 'Health & Wellness',
      'Home & Living', 'Food & Beverage', 'Fitness & Sports',
      'Outdoor & Adventure', 'Tech & Gadgets', 'Sustainable & Eco',
      'Baby & Kids', 'Pets', 'Travel & Luggage', 'Jewelry & Watches',
      'Personal Care & Grooming', 'Gifts & Novelty', 'Office & Stationery',
      'Art & Craft', 'Other'
    ]
  },
  categories:        [String],   // All applicable categories
  tags:              [String],   // Granular tags (e.g. "sustainable", "luxury", "subscription-box")
  productTypes:      [String],   // Specific product types (e.g. ["sneakers", "activewear"])
  targetDemographic: [String],   // e.g. ["women", "millennial", "urban"]
  priceRange: {
    type: String,
    enum: ['budget', 'mid-range', 'premium', 'luxury', 'mixed']
  },
  brandTier: {
    type: String,
    enum: ['emerging', 'established', 'premium', 'luxury', 'niche']
  },
  lifestyleTags:   [String],   // e.g. ["minimalist", "outdoor", "wellness"]
  genderFocus: {
    type: String,
    enum: ['women', 'men', 'unisex', 'kids', 'all']
  },

  // -- Quality & Affiliate Signals --------------------------------
  qualityScore:           { type: Number, min: 1, max: 10 }, // AI-scored
  affiliatePotentialScore:{ type: Number, min: 1, max: 10 }, // AI-scored
  audienceSize: {
    type: String,
    enum: ['niche', 'mid', 'large', 'mega']
  },
  affiliateNetworks:      [String], // e.g. ["ShareASale", "CJ", "Rakuten", "Impact"]
  contentScore:           { type: Number, min: 1, max: 10 }, // Quality of newsletter content
  hasAffiliateProgram:    { type: Boolean, default: false },
  estimatedRevShare:      String, // e.g. "5-10%"

  // -- Brand Social / Web Signals ---------------------------------
  instagramHandle:   String,
  twitterHandle:     String,
  tiktokHandle:      String,
  instagramFollowers:Number,
  foundedYear:       Number,
  headquarters:      String, // e.g. "New York, US"
  businessModel: {
    type: String,
    enum: ['dtc', 'retail', 'marketplace', 'subscription', 'hybrid']
  },

  // -- Discovery Metadata ----------------------------------------
  source:       { type: String, enum: ['milled.com', 'web_search', 'manual', 'referral', 'curated_seed', 'claude_ai', 'ollama_ai', 'ollama_pool'] },
  sourceUrl:    String,
  discoveredAt: { type: Date, default: Date.now },
  milledFrequency: String, // How often they send (from milled.com)
  milledIndustrialTags: [String],

  // -- Health Monitoring -----------------------------------------
  lastHealthCheckAt: Date,  // Last time we received any email from them
  isStale:           { type: Boolean, default: false }, // No email in 60+ days
  senderChangedAt:   Date,

  // -- Internal --------------------------------------------------
  addedBy:   { type: String, default: 'agent' },
  notes:     String,
  isDuplicate: { type: Boolean, default: false },
  duplicateOf: String, // domain of original if this is a duplicate

}, {
  timestamps: true,  // adds createdAt + updatedAt
  collection: 'brands'
});

// -- Indexes ----------------------------------------------------
BrandSchema.index({ domain: 1 }, { unique: true });
BrandSchema.index({ onboardingStatus: 1 });
BrandSchema.index({ primaryCategory: 1 });
BrandSchema.index({ affiliatePotentialScore: -1 });
BrandSchema.index({ qualityScore: -1 });
BrandSchema.index({ createdAt: -1 });
BrandSchema.index({ currentSenderEmail: 1 });
BrandSchema.index({ name: 'text', domain: 'text', description: 'text' }); // full-text search

// -- Instance Methods -------------------------------------------
BrandSchema.methods.updateStatus = function(newStatus, note = '') {
  this.onboardingStatus = newStatus;
  this.statusUpdatedAt = new Date();
  this.statusHistory.push({ status: newStatus, note });
  return this.save();
};

BrandSchema.methods.recordSenderChange = function(newEmail) {
  if (!newEmail) return this.save();
  const normalizedEmail = newEmail.toLowerCase().trim();
  const domainPart = normalizedEmail.includes('@') ? normalizeDomain(normalizedEmail.split('@').pop()) : '';
  const registrable = getRegistrableDomain(domainPart);
  const oldEmail = this.currentSenderEmail;
  const oldDomainPart = oldEmail && oldEmail.includes('@') ? normalizeDomain(oldEmail.split('@').pop()) : '';
  const oldRegistrable = getRegistrableDomain(oldDomainPart);
  if (oldEmail && oldEmail !== normalizedEmail) {
    // Archive the old email
    const existing = this.senderEmailHistory.find(h => h.email === oldEmail);
    if (existing) {
      existing.lastSeenAt = new Date();
    } else {
      this.senderEmailHistory.push({ email: oldEmail, reason: 'change_detected' });
    }
    // Treat local-part and subdomain rotations inside same domain network as non-critical changes.
    if (!oldRegistrable || !registrable || oldRegistrable !== registrable) {
      this.senderChangedAt = new Date();
    }
  }
  // Set the new email, also track it
  this.currentSenderEmail = normalizedEmail;
  this.primarySenderEmail = this.primarySenderEmail || normalizedEmail;
  const known = new Set((this.knownSenderEmails || []).map((email) => String(email).toLowerCase()));
  known.add(normalizedEmail);
  this.knownSenderEmails = Array.from(known);

  if (domainPart) {
    this.currentSenderDomain = domainPart;
    this.primarySenderDomain = this.primarySenderDomain || domainPart;
  }
  const domainSet = new Set((this.knownSenderDomains || []).map((domain) => String(domain).toLowerCase()));
  if (domainPart) domainSet.add(domainPart);
  if (registrable) domainSet.add(registrable);
  this.knownSenderDomains = Array.from(domainSet);

  const newEntry = this.senderEmailHistory.find(h => h.email === normalizedEmail);
  if (!newEntry) {
    this.senderEmailHistory.push({
      email: normalizedEmail,
      reason: oldEmail ? 'change_detected' : 'initial'
    });
  }
  return this.save();
};

// -- Static Methods ---------------------------------------------
BrandSchema.statics.findByDomain = function(domain) {
  const clean = domain.replace(/^www\./, '').toLowerCase().trim();
  return this.findOne({ domain: { $regex: new RegExp(clean, 'i') } });
};

BrandSchema.statics.findBySenderEmail = function(email) {
  return this.findOne({ currentSenderEmail: { $regex: new RegExp(email, 'i') } });
};

BrandSchema.statics.getStats = async function() {
  return this.aggregate([
    { $group: {
      _id: null,
      total:               { $sum: 1 },
      active:              { $sum: { $cond: [{ $eq: ['$onboardingStatus', 'active'] }, 1, 0] } },
      awaitingConfirmation:{ $sum: { $cond: [{ $eq: ['$onboardingStatus', 'awaiting_confirmation'] }, 1, 0] } },
      failed:              { $sum: { $cond: [{ $eq: ['$onboardingStatus', 'failed'] }, 1, 0] } },
      discovered:          { $sum: { $cond: [{ $eq: ['$onboardingStatus', 'discovered'] }, 1, 0] } },
      avgQuality:          { $avg: '$qualityScore' },
      avgAffiliate:        { $avg: '$affiliatePotentialScore' }
    }}
  ]);
};

module.exports = mongoose.model('Brand', BrandSchema);
