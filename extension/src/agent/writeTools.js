'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { isSensitivePath } = require('../contextRules');
const { resolveInsideWorkspace } = require('./permissions');

/**
 * Writing files is the only thing the agent does that changes the user's work,
 * so the design centres on one property: **every edit lands in VS Code's undo
 * stack**.
 *
 * That is why edits go through a `WorkspaceEdit` rather than `fs.writeFile`. A
 * model that edits the wrong function is a nuisance if Ctrl+Z puts it back, and
 * data loss if the write happened behind the editor's back. Nothing here may be
 * "optimised" into a direct write because the file happens to be closed.
 */

// Project memory is injected into every prompt, so a model that could edit it
// would be able to persist an instruction into all future turns. That is a
// prompt-injection amplifier rather than a convenience.
const PROTECTED_DIRECTORY = '.localcoder';

const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_WRITES_PER_TURN = 20;

const WRITE_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a file, or replace its entire contents. Prefer edit_file for changing part of an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace one exact substring in a file. old_text must appear exactly once; include enough surrounding context to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          old_text: { type: 'string', description: 'Exact text to replace. Must occur exactly once.' },
          new_text: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
];

function refuse(reason) {
  return { ok: false, content: `Refused: ${reason}` };
}

/**
 * Shared gate for both write tools. Returns the resolved absolute path, or a
 * refusal describing why not.
 */
function resolveWritablePath(workspacePath, relative) {
  if (typeof relative !== 'string' || relative === '') {
    return { error: 'a workspace-relative path is required.' };
  }
  const resolved = resolveInsideWorkspace(workspacePath, relative);
  if (!resolved) return { error: `"${relative}" is outside the workspace.` };

  // The same deny-list that keeps secrets out of the prompt keeps them from
  // being overwritten.
  if (isSensitivePath(resolved)) {
    return { error: `"${relative}" is an excluded path (secret, key, model, or generated output).` };
  }

  const relativeFromRoot = path.relative(path.resolve(workspacePath), resolved);
  const [firstSegment] = relativeFromRoot.split(path.sep);
  if (firstSegment === PROTECTED_DIRECTORY) {
    return {
      error:
        `"${relative}" is inside ${PROTECTED_DIRECTORY}/, which is included in every prompt. ` +
        'Editing it could persist an instruction into all future turns, so it is not writable.',
    };
  }
  return { resolved };
}

function checkContent(content) {
  if (typeof content !== 'string') return 'content must be a string.';
  // A NUL byte means this is not text; writing it would corrupt a binary.
  if (content.includes('\0')) return 'content contains a NUL byte, so it is not a text file.';
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    return `the result would exceed ${MAX_WRITE_BYTES} bytes.`;
  }
  return null;
}

/**
 * Applies a whole-file replacement through the editor so it is undoable.
 *
 * `applyEdit` is injected so tests can assert the edit went through VS Code
 * rather than through the filesystem — a later refactor to fs.writeFile must
 * fail the suite, not pass it quietly.
 */
async function writeFileTool(workspacePath, args, { applyEdit, readFile = fsp.readFile } = {}) {
  const { resolved, error } = resolveWritablePath(workspacePath, args?.path);
  if (error) return refuse(error);

  const content = args?.content;
  const contentError = checkContent(content);
  if (contentError) return refuse(contentError);

  let existed = true;
  let previous = '';
  try {
    previous = await readFile(resolved, 'utf8');
  } catch {
    existed = false;
  }
  if (existed && previous === content) {
    return { ok: true, content: `${args.path} already had exactly this content; nothing changed.` };
  }

  const applied = await applyEdit({ kind: 'replaceAll', file: resolved, content, existed });
  if (!applied) return refuse('the editor rejected the change.');

  const delta = Buffer.byteLength(content, 'utf8') - Buffer.byteLength(previous, 'utf8');
  return {
    ok: true,
    content: `${existed ? 'Rewrote' : 'Created'} ${args.path} (${delta >= 0 ? '+' : ''}${delta} bytes). Undo is available in the editor.`,
  };
}

/**
 * Replaces one exact substring.
 *
 * `old_text` must occur exactly once. Zero occurrences refuses; two or more
 * refuses and reports the count, because editing the first of several matches
 * is how the wrong call site gets silently corrupted. The model can then
 * re-read and send a longer, unique `old_text`.
 */
async function editFileTool(workspacePath, args, { applyEdit, readFile = fsp.readFile } = {}) {
  const { resolved, error } = resolveWritablePath(workspacePath, args?.path);
  if (error) return refuse(error);

  const oldText = args?.old_text;
  const newText = args?.new_text;
  if (typeof oldText !== 'string' || oldText === '') {
    return refuse('old_text is required and must be a non-empty string.');
  }
  if (typeof newText !== 'string') return refuse('new_text is required and must be a string.');

  let current;
  try {
    current = await readFile(resolved, 'utf8');
  } catch {
    return refuse(`"${args.path}" does not exist. Use write_file to create it deliberately.`);
  }

  let index = current.indexOf(oldText);
  if (index === -1) {
    return refuse(`old_text was not found in "${args.path}". Re-read the file and copy the exact text.`);
  }
  let occurrences = 0;
  for (let at = index; at !== -1; at = current.indexOf(oldText, at + oldText.length)) occurrences += 1;
  if (occurrences > 1) {
    return refuse(
      `old_text appears ${occurrences} times in "${args.path}". Include more surrounding context so it matches exactly once.`
    );
  }

  const updated = current.slice(0, index) + newText + current.slice(index + oldText.length);
  const contentError = checkContent(updated);
  if (contentError) return refuse(contentError);

  const applied = await applyEdit({ kind: 'replaceAll', file: resolved, content: updated, existed: true });
  if (!applied) return refuse('the editor rejected the change.');

  const delta = Buffer.byteLength(newText, 'utf8') - Buffer.byteLength(oldText, 'utf8');
  return {
    ok: true,
    content: `Edited ${args.path} (${delta >= 0 ? '+' : ''}${delta} bytes). Undo is available in the editor.`,
  };
}

module.exports = {
  MAX_WRITES_PER_TURN,
  MAX_WRITE_BYTES,
  PROTECTED_DIRECTORY,
  WRITE_TOOL_SCHEMAS,
  editFileTool,
  resolveWritablePath,
  writeFileTool,
};
