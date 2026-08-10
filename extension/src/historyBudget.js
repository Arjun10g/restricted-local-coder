'use strict';

/**
 * Choosing how much conversation to resend.
 *
 * A fixed character cap ignores the thing that actually overflows: the model's
 * context window. Two profiles here differ by 8K tokens of context, so the same
 * cap is wasteful on one and unsafe on the other.
 *
 * There is no tokenizer in this extension, and adding one would mean a runtime
 * dependency and a per-model vocabulary. Instead this estimates conservatively
 * and leaves a wide margin: over-trimming costs a little context, while
 * under-trimming makes llama-server drop the oldest messages itself, which
 * silently discards the system prompt's neighbours mid-conversation.
 */

// Deliberately pessimistic. Real code averages nearer 3.3 characters per token
// for common tokenizers; assuming fewer characters per token over-estimates the
// token count and therefore trims earlier.
const CHARACTERS_PER_TOKEN = 3;

// Every message carries role and delimiter overhead in the chat template.
const PER_MESSAGE_TOKEN_OVERHEAD = 4;

function estimateTokens(text) {
  const value = typeof text === 'string' ? text : '';
  return Math.ceil(value.length / CHARACTERS_PER_TOKEN) + PER_MESSAGE_TOKEN_OVERHEAD;
}

/**
 * Tokens available for prior turns, once everything that cannot be dropped has
 * been accounted for: the system prompt, the request itself, and room for the
 * reply. Returns zero rather than a negative number when the fixed parts alone
 * already fill the window — the caller then sends no history at all, which is
 * still a valid request.
 */
function availableHistoryTokens({ contextSize, systemText, userText, maxOutputTokens }) {
  const total = Number.isFinite(contextSize) && contextSize > 0 ? contextSize : 8192;
  const reserved = estimateTokens(systemText) + estimateTokens(userText) + Math.max(0, maxOutputTokens ?? 0);
  // Hold back a further 5% against tokenizer drift and template growth.
  const safety = Math.ceil(total * 0.05);
  return Math.max(0, total - reserved - safety);
}

/**
 * Selects the most recent whole turns that fit, newest first, then restores
 * chronological order.
 *
 * Messages are kept whole. A truncated assistant reply reads as though the model
 * stopped mid-thought and invites it to continue something it never said.
 */
function selectHistory(messages, budgetTokens, maxTurns) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const limit = Number.isFinite(maxTurns) && maxTurns >= 0 ? maxTurns * 2 : messages.length;
  const candidates = limit > 0 ? messages.slice(-limit) : [];
  const selected = [];
  let used = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const cost = estimateTokens(message?.content);
    if (used + cost > budgetTokens) break;
    used += cost;
    selected.unshift(message);
  }
  // A dangling assistant message with no preceding user turn is confusing to
  // the template; drop it so the history always starts on a user turn.
  while (selected.length > 0 && selected[0].role === 'assistant') {
    selected.shift();
  }
  return selected;
}

module.exports = {
  CHARACTERS_PER_TOKEN,
  PER_MESSAGE_TOKEN_OVERHEAD,
  availableHistoryTokens,
  estimateTokens,
  selectHistory,
};
