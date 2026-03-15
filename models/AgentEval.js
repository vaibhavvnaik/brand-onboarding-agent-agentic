const mongoose = require('mongoose');

const AgentEvalSchema = new mongoose.Schema({
  evalId: { type: String, required: true, unique: true, index: true },
  runId: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: ['pass', 'warn', 'fail'],
    default: 'warn',
    index: true
  },
  scores: {
    overall: { type: Number, min: 0, max: 100, required: true },
    reliability: { type: Number, min: 0, max: 100, required: true },
    backlogImpact: { type: Number, min: 0, max: 100, required: true },
    recovery: { type: Number, min: 0, max: 100, required: true },
    controllability: { type: Number, min: 0, max: 100, required: true }
  },
  findings: { type: [String], default: [] },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAtIso: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'agent_evals'
});

AgentEvalSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AgentEval', AgentEvalSchema);
