'use strict';

const { createAbortError, throwIfAborted } = require('./util');

class LlamaHttpError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'LlamaHttpError';
    this.status = status;
    this.payload = payload;
  }
}

function extractErrorMessage(payload, fallback) {
  if (payload && typeof payload === 'object') {
    return payload.error?.message || payload.message || fallback;
  }
  return fallback;
}

async function parseErrorResponse(response) {
  const text = await response.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Preserve plain-text diagnostics.
  }
  throw new LlamaHttpError(
    extractErrorMessage(payload, `llama-server returned HTTP ${response.status}`),
    response.status,
    payload
  );
}

function partsText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function deltaText(delta) {
  if (!delta) return '';
  return partsText(delta.content);
}

/**
 * The model's private analysis channel, kept strictly apart from the answer.
 *
 * A reasoning model streams its scratchpad as `reasoning_content` and only then
 * opens `content`. Reading solely `content` -- which this client used to do --
 * renders a blank bubble for the whole thinking phase, and if the token budget
 * runs out before the answer channel opens, forever: the response then carries a
 * full `reasoning_content` and an empty `content`, which looks exactly like a
 * broken model.
 *
 * It is returned separately, never concatenated into the answer. Reasoning must
 * not reach the editor through "Insert Last Response", must not be persisted,
 * and must not be replayed to the model on the next turn -- feeding a model its
 * own prior monologue spends context and degrades the reply.
 */
function deltaReasoning(delta) {
  if (!delta) return '';
  return partsText(delta.reasoning_content);
}

function messageReasoning(message) {
  if (!message) return '';
  return partsText(message.reasoning_content);
}

// Qwen's spelling, kept as the fallback because every fill-in-the-middle
// profile in the manifest today uses it. A profile may override it so a future
// model with different control tokens needs no code change.
const DEFAULT_FIM_TEMPLATE = {
  prefix: '<|fim_prefix|>',
  suffix: '<|fim_suffix|>',
  middle: '<|fim_middle|>',
  stop: ['<|fim_pad|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|im_end|>'],
};

function buildFimPrompt(profile, prefix, suffix) {
  const template = { ...DEFAULT_FIM_TEMPLATE, ...(profile?.fimTemplate ?? {}) };
  const stop = Array.isArray(template.stop) && template.stop.length > 0 ? template.stop : DEFAULT_FIM_TEMPLATE.stop;
  return {
    prompt: `${template.prefix}${prefix}${template.suffix}${suffix}${template.middle}`,
    stop,
  };
}

/**
 * Removes a reasoning block that arrived inline in `content` instead of on
 * `reasoning_content`.
 *
 * Not the normal path: llama-server's default --reasoning-format extracts the
 * analysis into its own field, so this matches nothing. It exists for the case
 * where it does not -- a future model whose template emits the tags literally,
 * or a profile someone runs with --reasoning-format none. Without this, the
 * tags are appended to the conversation history and replayed to the model on
 * every subsequent turn, so the context fills with the model's own monologue
 * and never recovers. It is applied where text is stored, not where it is
 * displayed, so a partial block mid-stream is never half-stripped.
 */
function stripInlineReasoning(text) {
  if (typeof text !== 'string' || !text.includes('<think')) return typeof text === 'string' ? text : '';
  return text.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think\s*>/gi, '').trim();
}

const REASONING_STRENGTHS = new Set(['low', 'medium', 'high', 'xhigh']);

/**
 * How hard the model should think, asked for per request rather than at launch.
 *
 * Muse Glimmer's chat template takes a `reasoning_strength` argument and
 * defaults to `high`, the most expensive setting -- so sending nothing was
 * silently buying the slowest mode. Measured on the same prompt and machine,
 * `low` produced 73 analysis tokens against 589 at `high`, cutting the wait for
 * the first word of the answer from 147s to 27s.
 *
 * It goes in the request body, not the argv, which is what lets a short
 * "explain this selection" ask for less thinking than an agent step without
 * restarting the server. Nothing is sent for a profile that does not declare
 * `reasoning`, so a model with no analysis channel is never handed an argument
 * its template cannot use.
 */
function reasoningOptions(profile, strength) {
  if (!profile?.reasoning || !strength) return {};
  const wanted = String(strength).toLowerCase();
  if (!REASONING_STRENGTHS.has(wanted)) return {};
  return { chat_template_kwargs: { reasoning_strength: wanted } };
}

class LlamaClient {
  constructor({ baseUrl, apiKey, modelAlias = 'local-coder' }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.apiKey = apiKey;
    this.modelAlias = modelAlias;
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async health(signal) {
    const response = await fetch(`${this.baseUrl}/health`, { signal });
    if (!response.ok) {
      await parseErrorResponse(response);
    }
    return response.json();
  }

  async chatStream({ messages, profile, signal, onToken, onReasoning, maxTokens, reasoningStrength }) {
    throwIfAborted(signal);
    const sampling = profile?.sampling ?? {};
    const body = {
      ...reasoningOptions(profile, reasoningStrength),
      model: this.modelAlias,
      messages,
      stream: true,
      max_tokens: maxTokens ?? profile?.maxOutputTokens ?? 2048,
      temperature: sampling.temperature ?? 0.2,
      top_p: sampling.topP ?? 0.9,
      top_k: sampling.topK ?? 40,
      min_p: sampling.minP ?? 0.02,
      repeat_penalty: sampling.repeatPenalty ?? 1.0,
      cache_prompt: true,
    };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await parseErrorResponse(response);
    }
    if (!response.body) {
      throw new LlamaHttpError('llama-server returned no response body', response.status, null);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let output = '';
    let reasoning = '';
    let usage = null;

    // Deliberately two accumulators. Appending reasoning to `output` would put
    // the model's scratchpad into the chat history, the persisted transcript,
    // and "Insert Last Response at Cursor" -- that is, into the user's source.
    const consume = (delta) => {
      const thought = deltaReasoning(delta);
      if (thought) {
        reasoning += thought;
        onReasoning?.(thought, reasoning);
      }
      const token = deltaText(delta);
      if (token) {
        output += token;
        onToken?.(token, output);
      }
    };

    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch (error) {
          throw new LlamaHttpError(`Invalid SSE JSON from llama-server: ${error.message}`, response.status, data);
        }
        if (event.error) {
          throw new LlamaHttpError(extractErrorMessage(event, 'Generation failed'), response.status, event);
        }
        usage = event.usage ?? usage;
        consume(event.choices?.[0]?.delta);
      }

      if (done) break;
    }

    if (pending.trim().startsWith('data:')) {
      const data = pending.trim().slice(5).trim();
      if (data && data !== '[DONE]') {
        const event = JSON.parse(data);
        consume(event.choices?.[0]?.delta);
        usage = event.usage ?? usage;
      }
    }

    return { text: output, reasoning, usage };
  }

  /**
   * A single non-streaming turn that may return tool calls.
   *
   * Streaming is not used here because a tool call is only actionable once it is
   * complete, and reassembling partial JSON argument deltas adds a parser whose
   * failure mode is executing a half-formed request.
   */
  async chatWithTools({ messages, profile, tools, signal, maxTokens, reasoningStrength }) {
    throwIfAborted(signal);
    const sampling = profile?.sampling ?? {};
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ...reasoningOptions(profile, reasoningStrength),
        model: this.modelAlias,
        messages,
        tools,
        tool_choice: 'auto',
        stream: false,
        max_tokens: maxTokens ?? profile?.maxOutputTokens ?? 2048,
        temperature: sampling.temperature ?? 0.2,
        top_p: sampling.topP ?? 0.9,
        top_k: sampling.topK ?? 40,
        min_p: sampling.minP ?? 0.02,
        repeat_penalty: sampling.repeatPenalty ?? 1.0,
      }),
      signal,
    });
    if (!response.ok) {
      await parseErrorResponse(response);
    }
    const payload = await response.json();
    if (payload.error) {
      throw new LlamaHttpError(extractErrorMessage(payload, 'Tool-calling request failed'), response.status, payload);
    }
    const message = payload.choices?.[0]?.message ?? {};
    return {
      message,
      // Surfaced so a caller can explain an empty answer, never to be replayed
      // to the model or shown as the answer itself.
      reasoning: messageReasoning(message),
      usage: payload.usage ?? null,
    };
  }

  async completeFim({ prefix, suffix, profile, signal, maxTokens = 96 }) {
    throwIfAborted(signal);
    // Sending Qwen control tokens to a model that has none produces confident
    // nonsense rather than an error, so refuse the request outright instead.
    if (profile && profile.fim === false) {
      throw new Error(
        `${profile.shortName ?? profile.id} has no fill-in-the-middle tokens, so inline completion is unavailable for this profile.`
      );
    }
    const { prompt, stop } = buildFimPrompt(profile, prefix, suffix);
    const sampling = profile?.sampling ?? {};
    const response = await fetch(`${this.baseUrl}/completion`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        prompt,
        n_predict: maxTokens,
        stream: false,
        temperature: Math.min(sampling.temperature ?? 0.2, 0.25),
        top_p: sampling.topP ?? 0.9,
        top_k: sampling.topK ?? 40,
        min_p: sampling.minP ?? 0.02,
        repeat_penalty: sampling.repeatPenalty ?? 1.0,
        cache_prompt: true,
        stop,
      }),
      signal,
    });
    if (!response.ok) {
      await parseErrorResponse(response);
    }
    const payload = await response.json();
    if (payload.error) {
      throw new LlamaHttpError(extractErrorMessage(payload, 'FIM generation failed'), response.status, payload);
    }
    return String(payload.content ?? payload.choices?.[0]?.text ?? '');
  }

  async abortableDelay(milliseconds, signal) {
    if (signal?.aborted) throw createAbortError();
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(createAbortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

module.exports = {
  DEFAULT_FIM_TEMPLATE,
  LlamaClient,
  LlamaHttpError,
  buildFimPrompt,
  deltaReasoning,
  reasoningOptions,
  stripInlineReasoning,
  deltaText,
  messageReasoning,
};
