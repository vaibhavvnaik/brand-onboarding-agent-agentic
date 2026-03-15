const axios = require('axios');
const Brand = require('../models/Brand');
const SignupRecoveryTask = require('../models/SignupRecoveryTask');
const { signUpForNewsletter } = require('./newsletterSignup');
const logger = require('../utils/logger');

function buildCoworkPrompt({ brandName, websiteUrl, failureCategory, failureCode }) {
  return [
    `Brand: ${brandName}`,
    `Website: ${websiteUrl}`,
    `Goal: subscribe newsletter using configured mailbox`,
    `Last failure: ${failureCategory || 'unknown'}${failureCode ? `/${failureCode}` : ''}`,
    'Find newsletter form, submit, verify success or capture blocker reason.'
  ].join('\n');
}

async function enqueueSignupRecoveryTask({ brand, signupResult }) {
  if (!brand?._id) return null;
  const coworkPrompt = buildCoworkPrompt({
    brandName: brand.name,
    websiteUrl: brand.websiteUrl,
    failureCategory: signupResult?.failureCategory,
    failureCode: signupResult?.failureCode
  });

  const task = await SignupRecoveryTask.findOneAndUpdate(
    { brandId: brand._id, status: { $in: ['pending', 'in_progress'] } },
    {
      $set: {
        brandName: brand.name,
        domain: brand.domain,
        websiteUrl: brand.websiteUrl,
        status: 'pending',
        source: 'signup_failure',
        failureCategory: signupResult?.failureCategory || null,
        failureCode: signupResult?.failureCode || null,
        lastError: signupResult?.error || null,
        coworkPrompt,
        context: {
          signupResult: signupResult || null,
          signupFormUrl: brand.signupFormUrl || null
        }
      },
      $setOnInsert: {
        brandId: brand._id,
        attempts: 0,
        maxAttempts: Number(process.env.SIGNUP_RECOVERY_MAX_ATTEMPTS || 3),
        assignedTo: 'agent'
      }
    },
    { upsert: true, new: true }
  );
  return task;
}

async function maybeRunMcpCoworkTask(task) {
  const endpoint = String(process.env.SIGNUP_RECOVERY_MCP_ENDPOINT || '').trim();
  const toolName = String(process.env.SIGNUP_RECOVERY_MCP_TOOL || '').trim();
  if (!endpoint || !toolName) return { handled: false };

  const payload = {
    jsonrpc: '2.0',
    id: `signup_recovery_${Date.now()}`,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: {
        brandName: task.brandName,
        websiteUrl: task.websiteUrl,
        coworkPrompt: task.coworkPrompt
      }
    }
  };
  const response = await axios.post(endpoint, payload, {
    timeout: Number(process.env.SIGNUP_RECOVERY_MCP_TIMEOUT_MS || 60000),
    headers: { 'Content-Type': 'application/json' }
  });
  return { handled: true, response: response?.data?.result || response?.data || {} };
}

async function recoverFailedSignups({ limit = 10 } = {}) {
  const tasks = await SignupRecoveryTask.find({
    status: 'pending',
    attempts: { $lt: Number(process.env.SIGNUP_RECOVERY_MAX_ATTEMPTS || 3) }
  })
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Number(limit || 10)));

  const stats = {
    scanned: tasks.length,
    attempted: 0,
    resolved: 0,
    failed: 0,
    deferredToMcp: 0
  };

  for (const task of tasks) {
    stats.attempted += 1;
    task.status = 'in_progress';
    task.attempts += 1;
    task.lastTriedAt = new Date();
    await task.save();

    const brand = await Brand.findById(task.brandId);
    if (!brand) {
      task.status = 'failed';
      task.lastError = 'brand_not_found';
      await task.save();
      stats.failed += 1;
      continue;
    }

    try {
      const mcpResult = await maybeRunMcpCoworkTask(task).catch(() => ({ handled: false }));
      if (mcpResult.handled) {
        task.status = 'resolved';
        task.resolvedAt = new Date();
        task.context = { ...(task.context || {}), mcpResult: mcpResult.response || {} };
        await task.save();
        stats.deferredToMcp += 1;
        stats.resolved += 1;
        continue;
      }

      const retry = await signUpForNewsletter(brand.websiteUrl, `${brand.name} (recovery)`);
      if (retry.success) {
        brand.signupError = null;
        brand.signupFailureCategory = null;
        brand.signupFailureCode = null;
        brand.signupFailureAt = null;
        await brand.updateStatus('awaiting_confirmation', 'Signup recovery task succeeded');

        task.status = 'resolved';
        task.resolvedAt = new Date();
        task.context = { ...(task.context || {}), retryResult: retry };
        await task.save();
        stats.resolved += 1;
      } else {
        task.lastError = retry.error || 'signup_recovery_failed';
        task.failureCategory = retry.failureCategory || task.failureCategory;
        task.failureCode = retry.failureCode || task.failureCode;
        task.status = task.attempts >= task.maxAttempts ? 'failed' : 'pending';
        task.context = { ...(task.context || {}), retryResult: retry };
        await task.save();
        stats.failed += 1;
      }
    } catch (err) {
      task.lastError = err.message;
      task.status = task.attempts >= task.maxAttempts ? 'failed' : 'pending';
      await task.save();
      stats.failed += 1;
      logger.warn(`[signup_recovery] task=${task._id} error=${err.message}`);
    }
  }

  return stats;
}

module.exports = {
  enqueueSignupRecoveryTask,
  recoverFailedSignups
};
