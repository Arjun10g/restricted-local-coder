'use strict';

/**
 * The analysis channel of a reasoning model.
 *
 * The default profile streams its private reasoning as `reasoning_content` and
 * only afterwards opens `content`. A client that reads `content` alone shows an
 * empty bubble for the entire thinking phase -- minutes, on CPU -- and shows
 * nothing at all when the output budget is exhausted before the answer starts.
 *
 * These tests hold both halves of the fix: the reasoning is delivered, and it
 * never reaches the answer, the history, or the persisted transcript.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { LlamaClient, deltaReasoning, deltaText, messageReasoning } = require('../src/client');

function streamResponse(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        const bytes = new TextEncoder().encode(body);
        let sent = false;
        return {
          async read() {
            if (sent) return { value: undefined, done: true };
            sent = true;
            return { value: bytes, done: false };
          },
        };
      },
    },
  };
}

function delta(value) {
  return { choices: [{ index: 0, delta: value }] };
}

async function withFetch(implementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('the reasoning channel is read, and stays out of the answer', () => {
  assert.equal(deltaReasoning({ reasoning_content: 'weighing options' }), 'weighing options');
  assert.equal(deltaReasoning({ reasoning_content: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.equal(deltaReasoning({ content: 'the answer' }), '');
  // The inverse, which is what shipped broken: content must not swallow it.
  assert.equal(deltaText({ reasoning_content: 'weighing options' }), '');
  assert.equal(messageReasoning({ reasoning_content: 'thought' }), 'thought');
  assert.equal(messageReasoning({ content: 'answer' }), '');
});

test('a stream that reasons before answering reports the two separately', async () => {
  const events = [
    delta({ role: 'assistant', content: null }),
    delta({ reasoning_content: 'first I ' }),
    delta({ reasoning_content: 'consider it' }),
    delta({ content: 'LOCAL_' }),
    delta({ content: 'RUNTIME_READY' }),
  ];
  const client = new LlamaClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  const answered = [];
  const thought = [];
  const result = await withFetch(async () => streamResponse(events), () =>
    client.chatStream({
      messages: [],
      profile: {},
      onToken: (token) => answered.push(token),
      onReasoning: (token) => thought.push(token),
    })
  );

  assert.equal(result.text, 'LOCAL_RUNTIME_READY');
  assert.equal(result.reasoning, 'first I consider it');
  assert.deepEqual(answered, ['LOCAL_', 'RUNTIME_READY']);
  assert.deepEqual(thought, ['first I ', 'consider it']);
  // The property that matters most: nothing the model thought is in the answer.
  assert.ok(!result.text.includes('consider'));
});

test('a reply that is all reasoning yields an empty answer rather than a leaked monologue', async () => {
  const events = [
    delta({ role: 'assistant', content: null }),
    delta({ reasoning_content: 'still thinking when the budget ran out' }),
  ];
  const client = new LlamaClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  const result = await withFetch(async () => streamResponse(events), () =>
    client.chatStream({ messages: [], profile: {} })
  );

  // An empty answer is the honest result. Substituting the reasoning here is
  // what would put the model's scratchpad into the user's source file, via
  // lastResponse and "Insert Last Response at Cursor".
  assert.equal(result.text, '');
  assert.equal(result.reasoning, 'still thinking when the budget ran out');
});

test('what is stored and replayed is the answer only', async () => {
  const events = [
    delta({ reasoning_content: 'the user probably wants X' }),
    delta({ content: 'Use a hash map.' }),
  ];
  const client = new LlamaClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  const result = await withFetch(async () => streamResponse(events), () =>
    client.chatStream({ messages: [], profile: {} })
  );

  // chatView pushes result.text, so this models the stored transcript and the
  // messages sent on the next turn.
  const history = [
    { role: 'user', content: 'How do I dedupe?' },
    { role: 'assistant', content: result.text },
  ];
  const serialized = JSON.stringify(history);
  assert.ok(!serialized.includes('probably wants'), 'reasoning must not be persisted or replayed');
  assert.equal(history[1].content, 'Use a hash map.');
});

test('tool calls survive an empty content field, and reasoning is reported beside them', async () => {
  const payload = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'I should look at the diff',
          tool_calls: [{ id: 'c1', function: { name: 'run_command', arguments: '{"argv":["git","diff"]}' } }],
        },
      },
    ],
    usage: { completion_tokens: 3 },
  };
  const client = new LlamaClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  const result = await withFetch(
    async () => ({ ok: true, status: 200, json: async () => payload }),
    () => client.chatWithTools({ messages: [], profile: {}, tools: [] })
  );

  assert.equal(result.message.content, '');
  assert.equal(result.message.tool_calls.length, 1);
  assert.equal(result.reasoning, 'I should look at the diff');
});

test('the chat request sends no stop list, because <|eom|> would truncate tool calls', async () => {
  // The FIM path has a stop list of Qwen control tokens. If that list -- or any
  // list containing the reasoning/tool separator -- ever reached the chat path,
  // generation would stop between the analysis and the tool call it introduces,
  // silently truncating every tool-using turn.
  let sent = null;
  const client = new LlamaClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  await withFetch(
    async (_url, init) => {
      sent = JSON.parse(init.body);
      return streamResponse([delta({ content: 'ok' })]);
    },
    () => client.chatStream({ messages: [], profile: { maxOutputTokens: 4096 } })
  );
  assert.ok(!('stop' in sent), 'the chat request body must not carry a stop list');

  let toolSent = null;
  await withFetch(
    async (_url, init) => {
      toolSent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) };
    },
    () => client.chatWithTools({ messages: [], profile: {}, tools: [] })
  );
  assert.ok(!('stop' in toolSent), 'the tool-calling request body must not carry a stop list');
});

test('the runtime never suppresses the reasoning channel at the server', () => {
  // --reasoning-format none folds the analysis back into content, which would
  // put the model's monologue straight into the answer and undo the split.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeManager.js'), 'utf8');
  assert.ok(!source.includes('--reasoning-format'), 'the runtime must not set --reasoning-format');
});
