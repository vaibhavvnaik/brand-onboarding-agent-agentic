const mongoose = require('mongoose');

const DiscoveryCandidateSchema = new mongoose.Schema({
  domain: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  websiteUrl: { type: String, required: true },
  description: { type: String, default: '' },
  primaryCategory: { type: String, default: 'Other' },
  tier: { type: String, default: 'established' },
  source: { type: String, default: 'ollama_pool' },
  sourceUrl: { type: String, default: 'ollama://discovery-pool' },
  qualityScore: { type: Number, default: 6 },
  affiliatePotentialScore: { type: Number, default: 5 },
  poolScore: { type: Number, default: 0 },
  status: { type: String, enum: ['queued', 'disabled'], default: 'queued' },
  disabledReason: { type: String, default: null },
  timesServed: { type: Number, default: 0 },
  lastServedAt: { type: Date, default: null }
}, {
  timestamps: true,
  collection: 'discovery_candidates'
});

DiscoveryCandidateSchema.index({ status: 1, poolScore: -1, createdAt: 1 });
DiscoveryCandidateSchema.index({ primaryCategory: 1, status: 1 });

module.exports = mongoose.model('DiscoveryCandidate', DiscoveryCandidateSchema);
