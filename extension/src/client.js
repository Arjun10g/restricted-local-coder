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

  async completeFim({ prefix, suffix, profile, signal, maxTokens = 96 }) {
    throwIfAborted(signal);
    const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
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
        stop: ['<|fim_pad|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|im_end|>'],
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
  LlamaClient,
  LlamaHttpError,
  deltaText,
};
