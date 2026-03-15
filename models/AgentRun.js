const mongoose = require('mongoose');

const AgentStepSchema = new mongoose.Schema({
  sequence: { type: Number, required: true },
  tool: { type: String, required: true },
  rationale: { type: String, default: '' },
  status: {
    type: String,
    enum: ['planned', 'running', 'success', 'failed', 'skipped'],
    default: 'planned'
  },
  startedAt: Date,
  completedAt: Date,
  durationMs: Number,
  attempts: { type: Number, default: 0 },
  input: { type: mongoose.Schema.Types.Mixed, default: null },
  output: { type: mongoose.Schema.Types.Mixed, default: null },
  error: String
}, { _id: false });

const AgentCheckpointSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  phase: { type: String, required: true },
  summary: { type: String, default: '' },
  state: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

const AgentRunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true, index: true },
  objective: { type: String, required: true },
  status: {
    type: String,
    enum: ['running', 'success', 'partial', 'failed', 'stopped'],
    default: 'running',
    index: true
  },
  trigger: { type: String, enum: ['api', 'cli', 'scheduler'], default: 'api' },
  options: { type: mongoose.Schema.Types.Mixed, default: {} },
  planner: {
    provider: { type: String, default: 'heuristic' },
    model: { type: String, default: null },
    calls: { type: Number, default: 0 },
    lastDecision: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  control: {
    allowedTools: { type: [String], default: [] },
    blockedTools: { type: [String], default: [] },
    requireApprovalFor: { type: [String], default: [] },
    maxSteps: Number,
    maxToolFailures: Number
  },
  approvals: {
    pending: { type: Boolean, default: false },
    pendingTool: String,
    requestedAt: Date,
    reason: String,
    approvedAt: Date,
    approvedBy: String
  },
  steps: { type: [AgentStepSchema], default: [] },
  checkpoints: { type: [AgentCheckpointSchema], default: [] },
  memory: {
    shortTerm: { type: mongoose.Schema.Types.Mixed, default: {} },
    longTerm: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  metrics: {
    toolsRun: { type: Number, default: 0 },
    toolFailures: { type: Number, default: 0 },
    retries: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
    durationMs: Number
  },
  error: String
}, {
  timestamps: true,
  collection: 'agent_runs'
});

AgentRunSchema.index({ createdAt: -1 });
AgentRunSchema.index({ 'metrics.startedAt': -1 });

module.exports = mongoose.model('AgentRun', AgentRunSchema);
