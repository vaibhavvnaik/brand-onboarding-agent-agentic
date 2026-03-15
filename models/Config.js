/**
 * Simple key-value config store in MongoDB.
 * Used to persist the Gmail refresh token obtained via web OAuth flow.
 */
const mongoose = require('mongoose');

const ConfigSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true },
  value:     { type: mongoose.Schema.Types.Mixed },
  updatedAt: { type: Date, default: Date.now }
});

ConfigSchema.statics.get = async function(key) {
  const doc = await this.findOne({ key });
  return doc ? doc.value : null;
};

ConfigSchema.statics.set = async function(key, value) {
  await this.findOneAndUpdate(
    { key },
    { key, value, updatedAt: new Date() },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('Config', ConfigSchema);
