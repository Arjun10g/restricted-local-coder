'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { editFileTool, writeFileTool } = require('../src/agent/writeTools');
const { evaluate, isWriteTool } = require('../src/agent/permissions');
const { executeTool, toolSchemasFor } = require('../src/agent/tools');

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-write-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
}

/**
 * Stands in for vscode.workspace.applyEdit. Recording every call is the point:
 * a change that reaches the filesystem without passing through here would not
 * be undoable, which is the property these tools exist to preserve.
 */
function recordingEditor() {
  const calls = [];
  return {
    calls,
    applyEdit: async (edit) => {
      calls.push(edit);
      await fsp.writeFile(edit.file, edit.content);
      return true;
    },
  };
}

test('every change goes through the editor, never straight to disk', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();
  const target = path.join(root, 'app.js');

  await writeFileTool(root, { path: 'app.js', content: 'const a = 1;\n' }, { applyEdit: editor.applyEdit });
  assert.equal(editor.calls.length, 1, 'write_file must go through applyEdit');
  assert.equal(editor.calls[0].file, target);

  await editFileTool(root, { path: 'app.js', old_text: 'const a = 1;', new_text: 'const a = 2;' }, { applyEdit: editor.applyEdit });
  assert.equal(editor.calls.length, 2, 'edit_file must go through applyEdit');
  assert.equal(await fsp.readFile(target, 'utf8'), 'const a = 2;\n');
});

test('a write is refused outright when no editor is available', async (t) => {
  const root = workspace(t);
  // Falling back to fs.writeFile here would produce a change the user cannot
  // undo, so refusing is the correct behaviour.
  const result = await executeTool({
    name: 'write_file',
    args: { path: 'a.js', content: 'x' },
    workspacePath: root,
    mode: 'allowlist',
    allowWrite: true,
    applyEdit: undefined,
  });
  assert.equal(result.ok, false);
  assert.match(result.content, /never bypass the editor/);
  assert.equal(fs.existsSync(path.join(root, 'a.js')), false);
});

test('edit_file demands a unique match and never guesses', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();
  await fsp.writeFile(path.join(root, 'dup.js'), 'call();\nother();\ncall();\n');

  const ambiguous = await editFileTool(
    root,
    { path: 'dup.js', old_text: 'call();', new_text: 'renamed();' },
    { applyEdit: editor.applyEdit }
  );
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.content, /appears 2 times/);
  assert.equal(editor.calls.length, 0, 'an ambiguous edit must not be applied');

  const missing = await editFileTool(
    root,
    { path: 'dup.js', old_text: 'nowhere();', new_text: 'x();' },
    { applyEdit: editor.applyEdit }
  );
  assert.equal(missing.ok, false);
  assert.match(missing.content, /not found/);

  // Enough surrounding context makes it unique, and only that site changes.
  const unique = await editFileTool(
    root,
    { path: 'dup.js', old_text: 'other();\ncall();', new_text: 'other();\nrenamed();' },
    { applyEdit: editor.applyEdit }
  );
  assert.equal(unique.ok, true);
  assert.equal(await fsp.readFile(path.join(root, 'dup.js'), 'utf8'), 'call();\nother();\nrenamed();\n');
});

test('edit_file will not create a file, and write_file will', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();

  const edit = await editFileTool(root, { path: 'new.js', old_text: 'a', new_text: 'b' }, { applyEdit: editor.applyEdit });
  assert.equal(edit.ok, false);
  assert.match(edit.content, /does not exist/);

  const write = await writeFileTool(root, { path: 'new.js', content: 'created\n' }, { applyEdit: editor.applyEdit });
  assert.equal(write.ok, true);
  assert.match(write.content, /Created/);
});

test('writes are confined, and refuse secrets and project memory', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();
  const attempt = (p) => writeFileTool(root, { path: p, content: 'x' }, { applyEdit: editor.applyEdit });

  assert.equal((await attempt('../escape.js')).ok, false);
  assert.equal((await attempt('/etc/passwd')).ok, false);
  assert.equal((await attempt('.env')).ok, false);
  assert.equal((await attempt('id_rsa.pem')).ok, false);

  // Project memory is injected into every prompt; a model that could edit it
  // could persist an instruction into all future turns.
  const memory = await attempt('.localcoder/memory.md');
  assert.equal(memory.ok, false);
  assert.match(memory.content, /every prompt/);

  assert.equal(editor.calls.length, 0, 'no refused path may reach the editor');
});

test('binary content and oversized results are refused', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();

  const nul = await writeFileTool(root, { path: 'a.bin', content: 'ok\0bad' }, { applyEdit: editor.applyEdit });
  assert.equal(nul.ok, false);
  assert.match(nul.content, /NUL byte/);

  const huge = await writeFileTool(root, { path: 'big.js', content: 'x'.repeat(2 * 1024 * 1024) }, { applyEdit: editor.applyEdit });
  assert.equal(huge.ok, false);
  assert.equal(editor.calls.length, 0);
});

test('writing is gated separately from running commands', () => {
  // Off and readonly refuse regardless of allowWrite.
  assert.equal(evaluate({ mode: 'off', tool: 'write_file', allowWrite: true }).allowed, false);
  assert.equal(evaluate({ mode: 'readonly', tool: 'write_file', allowWrite: true }).allowed, false);

  // Permission to run commands is not permission to edit files.
  assert.equal(evaluate({ mode: 'allowlist', tool: 'write_file', allowWrite: false }).allowed, false);
  assert.equal(evaluate({ mode: 'allowlist', tool: 'write_file', allowWrite: true }).allowed, true);

  // Confirm mode confirms every write, as it does every command.
  assert.equal(evaluate({ mode: 'confirm', tool: 'edit_file', allowWrite: true }).needsConfirmation, true);

  assert.equal(isWriteTool('write_file'), true);
  assert.equal(isWriteTool('edit_file'), true);
  assert.equal(isWriteTool('read_file'), false);
});

test('the write tools are not offered to the model unless writing is allowed', () => {
  const readOnly = toolSchemasFor({}).map((s) => s.function.name);
  assert.ok(!readOnly.includes('write_file'));
  assert.ok(!readOnly.includes('edit_file'));

  const withWrite = toolSchemasFor({ allowWrite: true }).map((s) => s.function.name);
  assert.ok(withWrite.includes('write_file'));
  assert.ok(withWrite.includes('edit_file'));
});

test('a declined confirmation changes nothing', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();
  const result = await executeTool({
    name: 'write_file',
    args: { path: 'a.js', content: 'x' },
    workspacePath: root,
    mode: 'confirm',
    allowWrite: true,
    applyEdit: editor.applyEdit,
    confirm: async () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(editor.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'a.js')), false);
});

test('the per-turn write cap bounds a runaway loop', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();
  const writeCounter = { count: 0 };
  const results = [];
  for (let index = 0; index < 25; index += 1) {
    results.push(
      await executeTool({
        name: 'write_file',
        args: { path: `f${index}.js`, content: 'x' },
        workspacePath: root,
        mode: 'allowlist',
        allowWrite: true,
        applyEdit: editor.applyEdit,
        writeCounter,
      })
    );
  }
  assert.equal(editor.calls.length, 20, 'must stop at the cap');
  assert.equal(results.filter((r) => !r.ok).length, 5);
  assert.match(results.at(-1).content, /limit/);
});

test('the audit records the path but never the content', async (t) => {
  const root = workspace(t);
  const editor = recordingEditor();
  const entries = [];
  await executeTool({
    name: 'write_file',
    args: { path: 'secret-logic.js', content: 'const apiKey = "hunter2";' },
    workspacePath: root,
    mode: 'allowlist',
    allowWrite: true,
    applyEdit: editor.applyEdit,
    audit: (entry) => entries.push(entry),
  });
  const { summarizeArguments } = require('../src/agent/auditLog');
  const summary = summarizeArguments('write_file', entries.at(-1).args);
  assert.match(summary, /secret-logic\.js/);
  assert.ok(!summary.includes('hunter2'), 'file contents must never reach the audit log');
});
