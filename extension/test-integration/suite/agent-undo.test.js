'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { test } = require('../harness');

const { ChatViewProvider } = require('../../src/chatView');
const { editFileTool, writeFileTool } = require('../../src/agent/writeTools');

/**
 * The undo guarantee, executed against a real editor.
 *
 * writeTools takes `applyEdit` as an injected function, and every offline test
 * passes a stub that records the call. That shape verifies the tools ask for an
 * edit; it cannot verify that what VS Code does with the request is undoable,
 * because no VS Code is present. Undo is the whole reason writing to a user's
 * files is defensible -- "a wrong edit is Ctrl+Z, not data loss" -- so it needs
 * to be exercised where undo actually exists.
 */

const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;

/** The real method, with the one field it touches. Not a reimplementation. */
function provider() {
  const instance = Object.create(ChatViewProvider.prototype);
  instance.output = { appendLine() {} };
  return instance;
}

const applyEdit = (edit) => provider().applyAgentEdit(edit);

async function seed(name, content) {
  const file = path.join(workspace, name);
  await fsp.writeFile(file, content, 'utf8');
  return file;
}

/** Undo applies to the active editor, so the document must be showing. */
async function open(file) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

test('an agent edit to an existing file is undoable', async () => {
  const file = await seed('existing.js', 'const answer = 1;\n');
  const document = await open(file);

  const result = await editFileTool(
    workspace,
    { path: 'existing.js', old_text: 'const answer = 1;', new_text: 'const answer = 42;' },
    { applyEdit }
  );
  assert.equal(result.ok, true, result.content);
  assert.equal(document.getText(), 'const answer = 42;\n');

  await vscode.commands.executeCommand('undo');
  assert.equal(document.getText(), 'const answer = 1;\n', 'undo must restore the original text');
});

test('a whole-file rewrite is undoable in one step, not one per line', async () => {
  // A rewrite implemented as a per-line diff would need as many undos as lines
  // changed, which is not what "Ctrl+Z" means to the person who just watched a
  // model rewrite their file.
  const original = ['one', 'two', 'three', 'four', 'five'].join('\n') + '\n';
  const file = await seed('rewrite.txt', original);
  const document = await open(file);

  const result = await writeFileTool(workspace, { path: 'rewrite.txt', content: 'replaced\n' }, { applyEdit });
  assert.equal(result.ok, true, result.content);
  assert.equal(document.getText(), 'replaced\n');

  await vscode.commands.executeCommand('undo');
  assert.equal(document.getText(), original, 'one undo must restore the whole file');
});

test('an edit to a file that is not open is still undoable once opened', async () => {
  // The common case: the model edits something the user was not looking at.
  // VS Code keeps the edit in a dirty in-memory document, and the undo stack has
  // to survive the file being shown afterwards.
  const file = await seed('unopened.txt', 'before\n');
  const result = await editFileTool(
    workspace,
    { path: 'unopened.txt', old_text: 'before', new_text: 'after' },
    { applyEdit }
  );
  assert.equal(result.ok, true, result.content);

  const document = await open(file);
  assert.equal(document.getText(), 'after\n');
  await vscode.commands.executeCommand('undo');
  assert.equal(document.getText(), 'before\n');
});

test('creating a file leaves it dirty, so nothing reaches disk unsaved', async () => {
  // This is the property that makes an unwanted creation recoverable: the file
  // exists in the editor but its content is unsaved, so closing without saving
  // discards it.
  const name = 'created.txt';
  const result = await writeFileTool(workspace, { path: name, content: 'generated\n' }, { applyEdit });
  assert.equal(result.ok, true, result.content);

  const uri = vscode.Uri.file(path.join(workspace, name));
  const document = await vscode.workspace.openTextDocument(uri);
  assert.equal(document.getText(), 'generated\n');
  assert.equal(document.isDirty, true, 'an agent-created file must not be silently written to disk');
});

test('the edit is a document change, not a filesystem write behind the editor', async () => {
  // If writeTools ever bypassed WorkspaceEdit, disk would change while the open
  // document did not, and the user would lose work by saving over it. Asserting
  // the two disagree until save is what pins the edit to the editor.
  const file = await seed('ondisk.txt', 'disk\n');
  const document = await open(file);

  await editFileTool(workspace, { path: 'ondisk.txt', old_text: 'disk', new_text: 'buffer' }, { applyEdit });
  assert.equal(document.getText(), 'buffer\n');
  assert.equal(await fsp.readFile(file, 'utf8'), 'disk\n', 'the edit must be unsaved until the user saves it');
  assert.equal(document.isDirty, true);
});
