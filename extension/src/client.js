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

function deltaText(delta) {
  if (!delta) return '';
  if (typeof delta.content === 'string') return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
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

  async chatStream({ messages, profile, signal, onToken, maxTokens }) {
    throwIfAborted(signal);
    const sampling = profile?.sampling ?? {};
    const body = {
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
    let usage = null;

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
        const token = deltaText(event.choices?.[0]?.delta);
        if (token) {
          output += token;
          onToken?.(token, output);
        }
      }

      if (done) break;
    }

    if (pending.trim().startsWith('data:')) {
      const data = pending.trim().slice(5).trim();
      if (data && data !== '[DONE]') {
        const event = JSON.parse(data);
        const token = deltaText(event.choices?.[0]?.delta);
        if (token) {
          output += token;
          onToken?.(token, output);
        }
        usage = event.usage ?? usage;
      }
    }

    return { text: output, usage };
  }

  /**
   * A single non-streaming turn that may return tool calls.
   *
   * Streaming is not used here because a tool call is only actionable once it is
   * complete, and reassembling partial JSON argument deltas adds a parser whose
   * failure mode is executing a half-formed request.
   */
  async chatWithTools({ messages, profile, tools, signal, maxTokens }) {
    throwIfAborted(signal);
    const sampling = profile?.sampling ?? {};
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
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
    return {
      message: payload.choices?.[0]?.message ?? {},
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
  deltaText,
};
