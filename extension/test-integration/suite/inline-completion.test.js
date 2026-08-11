'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { test } = require('../harness');

const { InlineCompletionProvider } = require('../../src/inlineCompletion');

/**
 * The inline completion provider, driven through real editor objects.
 *
 * The offline suite tests `cleanCompletion` and `removeSuffixOverlap` as pure
 * functions, which is worth doing and leaves the provider itself unexercised.
 * Everything that decides whether a suggestion appears -- real TextDocument
 * offsets, a real CancellationToken, real settings, the InlineCompletionItem and
 * Range the editor actually consumes -- has no coverage without a live editor.
 *
 * The runtime and model registry are stubbed because a 16 GiB model cannot run
 * in CI. Nothing else is: the document, position, configuration and cancellation
 * are the editor's own.
 */

const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
const config = () => vscode.workspace.getConfiguration('localCoder');

async function configure(values) {
  for (const [key, value] of Object.entries(values)) {
    await config().update(key, value, vscode.ConfigurationTarget.Workspace);
  }
}

/** Records what the client was asked for, so prefix/suffix can be asserted. */
function harnessFor(completion, { ready = true, fim = true } = {}) {
  const calls = [];
  const provider = new InlineCompletionProvider(
    {
      snapshot: () => ({ ready }),
      getClient: () => ({
        completeFim: async (request) => {
          calls.push(request);
          return typeof completion === 'function' ? completion(request) : completion;
        },
      }),
    },
    { getSelectedProfile: () => ({ id: 'test', fim, shortName: 'Test' }) },
    { appendLine() {} }
  );
  return { provider, calls };
}

async function documentAt(name, content, marker = '<CURSOR>') {
  const index = content.indexOf(marker);
  const text = content.replace(marker, '');
  const file = path.join(workspace, name);
  await fsp.writeFile(file, text, 'utf8');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  return { document, position: document.positionAt(index === -1 ? text.length : index) };
}

const noCancel = new vscode.CancellationTokenSource().token;

test('a suggestion is returned as an InlineCompletionItem the editor can render', async () => {
  await configure({ 'inlineCompletions.enabled': true, 'inlineCompletions.debounceMs': 0 });
  const { document, position } = await documentAt('fim.js', 'function add(a, b) {\n  <CURSOR>\n}\n');
  const { provider, calls } = harnessFor('return a + b;');

  const items = await provider.provideInlineCompletionItems(document, position, {}, noCancel);
  assert.equal(items.length, 1);
  assert.ok(items[0] instanceof vscode.InlineCompletionItem);
  assert.equal(items[0].insertText, 'return a + b;');
  // A zero-width range at the cursor is what makes this an insertion rather
  // than a replacement of surrounding text.
  assert.ok(items[0].range.isEmpty, 'the range must be empty so nothing is overwritten');
  assert.ok(items[0].range.start.isEqual(position));

  // The split must follow the real document offset, not the line.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prefix.endsWith('function add(a, b) {\n  '));
  assert.ok(calls[0].suffix.startsWith('\n}'));
});

test('a file the context rules call sensitive never reaches the model', async () => {
  await configure({ 'inlineCompletions.enabled': true, 'inlineCompletions.debounceMs': 0 });
  const { document, position } = await documentAt('.env', 'API_KEY=<CURSOR>\n');
  const { provider, calls } = harnessFor('secret-value');

  const items = await provider.provideInlineCompletionItems(document, position, {}, noCancel);
  assert.equal(items, undefined);
  assert.equal(calls.length, 0, 'a secrets file must not be sent anywhere, even locally');
});

test('the feature is off unless it is turned on', async () => {
  await configure({ 'inlineCompletions.enabled': false });
  const { document, position } = await documentAt('off.js', 'const x = <CURSOR>\n');
  const { provider, calls } = harnessFor('1;');

  assert.equal(await provider.provideInlineCompletionItems(document, position, {}, noCancel), undefined);
  assert.equal(calls.length, 0);
});

test('nothing is requested while the runtime is not ready', async () => {
  await configure({ 'inlineCompletions.enabled': true, 'inlineCompletions.debounceMs': 0 });
  const { document, position } = await documentAt('notready.js', 'const x = <CURSOR>\n');
  const { provider, calls } = harnessFor('1;', { ready: false });

  assert.equal(await provider.provideInlineCompletionItems(document, position, {}, noCancel), undefined);
  assert.equal(calls.length, 0, 'a request before the server is up would hang the editor');
});

test('a model without fill-in-the-middle is not asked to fake it', async () => {
  await configure({ 'inlineCompletions.enabled': true, 'inlineCompletions.debounceMs': 0 });
  const { document, position } = await documentAt('nofim.js', 'const x = <CURSOR>\n');
  const { provider, calls } = harnessFor('1;', { fim: false });

  assert.equal(await provider.provideInlineCompletionItems(document, position, {}, noCancel), undefined);
  assert.equal(calls.length, 0);
});

test("VS Code's cancellation reaches the request rather than being ignored", async () => {
  // The editor cancels constantly -- every keystroke supersedes the last
  // request. If cancellation did not abort the in-flight call, typing would
  // queue a request per character against a server that handles one at a time.
  await configure({ 'inlineCompletions.enabled': true, 'inlineCompletions.debounceMs': 5000 });
  const { document, position } = await documentAt('cancel.js', 'const x = <CURSOR>\n');
  const { provider, calls } = harnessFor('1;');

  const source = new vscode.CancellationTokenSource();
  const pending = provider.provideInlineCompletionItems(document, position, {}, source.token);
  source.cancel();

  assert.equal(await pending, undefined, 'a cancelled completion must resolve, not reject');
  assert.equal(calls.length, 0, 'cancelling during the debounce must prevent the request entirely');
});

test('an identical second request is served from cache, not re-inferred', async () => {
  await configure({ 'inlineCompletions.enabled': true, 'inlineCompletions.debounceMs': 0 });
  const { document, position } = await documentAt('cache.js', 'const total = <CURSOR>\n');
  const { provider, calls } = harnessFor('sum(values);');

  const first = await provider.provideInlineCompletionItems(document, position, {}, noCancel);
  const second = await provider.provideInlineCompletionItems(document, position, {}, noCancel);
  assert.equal(calls.length, 1, 'the same position and document version must not be inferred twice');
  assert.equal(first[0].insertText, second[0].insertText);
});

test('a completion that only repeats the text after the cursor is suppressed', async () => {
  // The model frequently continues into what is already there. Offering it
  // produces a suggestion that appears to duplicate the rest of the line.
  await configure({ 'inlineCompletions.enabled': true, 'inlineCompletions.debounceMs': 0 });
  const { document, position } = await documentAt('overlap.js', 'const value = <CURSOR>compute();\n');
  const { provider } = harnessFor('compute();');

  const items = await provider.provideInlineCompletionItems(document, position, {}, noCancel);
  assert.equal(items, undefined, 'a suggestion identical to the suffix is not a suggestion');
});
