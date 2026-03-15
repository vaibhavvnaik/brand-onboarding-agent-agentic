const axios = require('axios');
const logger = require('../utils/logger');

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function getLlmConfig() {
  const baseUrl = String(process.env.OLLAMA_BASE_URL || process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const apiKey = process.env.OLLAMA_API_KEY || process.env.LLM_API_KEY || 'ollama';
  const model = process.env.OLLAMA_MODEL || process.env.LLM_MODEL || 'qwen2.5:0.5b';
  const timeoutMs = Math.max(5000, parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10));
  const enabled = !envFlag('LLM_DISABLED', false);
  return { baseUrl, apiKey, model, timeoutMs, enabled };
}

function isLlmAvailable() {
  const cfg = getLlmConfig();
  return cfg.enabled && !!cfg.baseUrl;
}

async function createChatCompletion({ phase = 'general', messages = [], model, maxTokens = 512, temperature = 0.1 } = {}) {
  const cfg = getLlmConfig();
  if (!cfg.enabled) {
    throw new Error('LLM_DISABLED=true');
  }

  const selectedModel = model || cfg.model;
  const url = `${cfg.baseUrl}/chat/completions`;
  const started = Date.now();

  try {
    const response = await axios.post(
      url,
      {
        model: selectedModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      },
      {
        timeout: cfg.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        }
      }
    );

    const data = response?.data || {};
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    const usage = data?.usage || {};
    const reqId = data?.id || 'unknown';
    const usedModel = data?.model || selectedModel;
    const latencyMs = Date.now() - started;

    logger.info(
      `[llm] phase=${phase} req_id=${reqId} in=${usage?.prompt_tokens ?? 'n/a'} out=${usage?.completion_tokens ?? 'n/a'} model=${usedModel} latency_ms=${latencyMs}`
    );

    if (!text) {
      throw new Error('Empty LLM response content');
    }

    return { text, id: reqId, usage, model: usedModel, latencyMs, raw: data };
  } catch (err) {
    const status = err?.response?.status;
    const bodyMsg = err?.response?.data?.error?.message || err?.response?.data?.error || err?.response?.data?.message;
    const details = bodyMsg ? ` status=${status || 'n/a'} body=${String(bodyMsg).slice(0, 240)}` : '';
    throw new Error(`LLM request failed: ${err.message}${details}`);
  }
}

module.exports = {
  createChatCompletion,
  getLlmConfig,
  isLlmAvailable
};
