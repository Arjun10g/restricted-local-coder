'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ConversationStore,
  MAX_PERSISTED_MESSAGES,
  conversationKey,
  sanitizeMessages,
} = require('../src/conversationStore');
const { availableHistoryTokens, estimateTokens, selectHistory } = require('../src/historyBudget');

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-chat-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ConversationStore(directory, { appendLine() {} });
}

test('a transcript round-trips and stays scoped to its workspace', async (t) => {
  const store = temporaryStore(t);
  const messages = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];
  await store.save('/work/project-a', messages);
  assert.deepEqual(await store.load('/work/project-a'), messages);
  // A different workspace must not see it.
  assert.deepEqual(await store.load('/work/project-b'), []);
});

test('the stored file name does not reveal the workspace path', async (t) => {
  const store = temporaryStore(t);
  await store.save('/Users/someone/secret-client-project', [{ role: 'user', content: 'hello' }]);
  const files = await fsp.readdir(path.join(store.storageDirectory, 'conversations'));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('secret-client-project'));
  assert.match(files[0], /^[a-f0-9]{32}\.json$/);
});

test('clearing removes the transcript so a later session cannot restore it', async (t) => {
  const store = temporaryStore(t);
  await store.save('/work/project', [{ role: 'user', content: 'hello' }]);
  await store.clear('/work/project');
  assert.deepEqual(await store.load('/work/project'), []);
  // Clearing something that was never written must not throw.
  await store.clear('/work/never-used');
});

test('a corrupt or foreign transcript is ignored rather than thrown', async (t) => {
  const store = temporaryStore(t);
  const file = store.fileFor('/work/project');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'this is not json');
  assert.deepEqual(await store.load('/work/project'), []);

  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 99, messages: [{ role: 'user', content: 'x' }] }));
  assert.deepEqual(await store.load('/work/project'), [], 'an unknown schema must not be trusted');
});

test('persisted messages are bounded and stripped of unexpected roles', () => {
  const noisy = [
    { role: 'system', content: 'should not persist' },
    { role: 'user', content: 'keep' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'keep too' },
    { role: 'user' },
  ];
  assert.deepEqual(sanitizeMessages(noisy), [
    { role: 'user', content: 'keep' },
    { role: 'assistant', content: 'keep too' },
  ]);

  const many = Array.from({ length: MAX_PERSISTED_MESSAGES + 50 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  }));
  assert.ok(sanitizeMessages(many).length <= MAX_PERSISTED_MESSAGES);

  // One enormous reply must not make the file unbounded.
  const huge = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'x'.repeat(900_000) }];
  const total = sanitizeMessages(huge).reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= 400_000);

  assert.deepEqual(sanitizeMessages(null), []);
});

test('a workspace key is stable, and the empty workspace still has one', () => {
  assert.equal(conversationKey('/work/project'), conversationKey('/work/project'));
  assert.notEqual(conversationKey('/work/a'), conversationKey('/work/b'));
  assert.match(conversationKey(''), /^[a-f0-9]{32}$/);
  assert.match(conversationKey(undefined), /^[a-f0-9]{32}$/);
});

test('the history budget follows the context window and reserves room to reply', () => {
  const small = availableHistoryTokens({
    contextSize: 8192,
    systemText: 'x'.repeat(3000),
    userText: 'y'.repeat(3000),
    maxOutputTokens: 2048,
  });
  const large = availableHistoryTokens({
    contextSize: 16384,
    systemText: 'x'.repeat(3000),
    userText: 'y'.repeat(3000),
    maxOutputTokens: 2048,
  });
  assert.ok(large > small, 'a larger context must allow more history');
  assert.ok(small > 0);

  // When the fixed parts already fill the window, the answer is zero, not a
  // negative budget that would let everything through.
  assert.equal(
    availableHistoryTokens({
      contextSize: 2048,
      systemText: 'x'.repeat(40_000),
      userText: 'y'.repeat(40_000),
      maxOutputTokens: 2048,
    }),
    0
  );
});

test('history selection keeps whole recent turns and never starts on an assistant reply', () => {
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'new answer' },
  ];
  assert.deepEqual(selectHistory(messages, 10_000, 6), messages);

  // A budget that fits only part of a turn drops to the previous whole turn
  // rather than truncating a reply mid-sentence.
  const tight = selectHistory(messages, estimateTokens('new answer') + 2, 6);
  assert.deepEqual(tight, [], 'a lone assistant reply must not lead the history');

  const oneTurn = selectHistory(messages, estimateTokens('new question') + estimateTokens('new answer'), 6);
  assert.deepEqual(oneTurn, [
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'new answer' },
  ]);

  assert.deepEqual(selectHistory(messages, 10_000, 0), [], 'zero turns means no history');
  assert.deepEqual(selectHistory([], 10_000, 6), []);
});

test('token estimates are pessimistic, so the budget trims early rather than late', () => {
  // Three characters per token under-counts real tokenizers, which is the safe
  // direction: over-estimating tokens costs a little context, under-estimating
  // makes the server silently drop messages.
  const text = 'a'.repeat(300);
  assert.ok(estimateTokens(text) >= 100);
  assert.equal(estimateTokens(''), estimateTokens(undefined));
});

test('history is evicted in batches so the prompt prefix stays reusable', () => {
  const { stableTurnLimit, selectHistory } = require('../src/historyBudget');

  // Under the limit nothing is dropped.
  for (let turns = 1; turns <= 6; turns += 1) {
    assert.equal(stableTurnLimit(turns, 6), turns);
  }

  // Past it, the oldest retained turn is what decides whether the server can
  // reuse the prefix. Sliding by one every turn would change it every turn and
  // force a full re-prefill of the whole history; holding it steady for a batch
  // pays that once instead.
  const oldestKept = (turns) => turns - stableTurnLimit(turns, 6) + 1;
  assert.equal(oldestKept(7), 4);
  assert.equal(oldestKept(8), 4, 'the window must not move on every turn');
  assert.equal(oldestKept(9), 4);
  assert.equal(oldestKept(10), 7, 'it moves once per batch');

  let moves = 0;
  let previous = oldestKept(1);
  for (let turns = 2; turns <= 15; turns += 1) {
    const current = oldestKept(turns);
    if (current !== previous) moves += 1;
    previous = current;
  }
  assert.equal(moves, 3, 'one-at-a-time eviction would move nine times over the same span');
});

test('batched eviction still returns whole turns starting on a user message', () => {
  const { selectHistory } = require('../src/historyBudget');
  const messages = [];
  for (let turn = 1; turn <= 10; turn += 1) {
    messages.push({ role: 'user', content: `question ${turn}` });
    messages.push({ role: 'assistant', content: `answer ${turn}` });
  }
  const selected = selectHistory(messages, 100000, 6);
  assert.equal(selected[0].role, 'user', 'history must never lead with an assistant reply');
  assert.equal(selected.length % 2, 0, 'turns are kept whole');
  assert.equal(selected.at(-1).content, 'answer 10', 'the most recent turn is always retained');
});
