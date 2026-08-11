'use strict';

const childProcess = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { isLikelySourcePath, isSensitivePath, neutralizeContextMarkup } = require('../contextRules');
const { evaluate, isWriteTool, resolveInsideWorkspace } = require('./permissions');
const {
  MAX_WRITES_PER_TURN,
  WRITE_TOOL_SCHEMAS,
  editFileTool,
  writeFileTool,
} = require('./writeTools');

const MAX_FILE_CHARACTERS = 20_000;
const MAX_LISTED_ENTRIES = 200;
const MAX_MATCHES = 60;
const MAX_COMMAND_OUTPUT = 20_000;
const COMMAND_TIMEOUT_MS = 120_000;

// Walking these wastes the step budget and can be enormous.
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', 'target', '.next']);

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the workspace. Paths are workspace-relative.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories under a workspace-relative directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative directory. Defaults to the workspace root.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Find workspace files containing a literal substring.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to find. Not a regular expression.' },
          path: { type: 'string', description: 'Workspace-relative directory to search. Defaults to the workspace root.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run an approved command. Provide argv as separate items; there is no shell, so operators such as && or | are literal arguments.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Argv array, e.g. ["npm", "test"].',
          },
        },
        required: ['command'],
      },
    },
  },
];

function refuse(reason) {
  return { ok: false, content: `Refused: ${reason}` };
}

function succeed(content) {
  // Tool results re-enter the prompt, so they are neutralized exactly like any
  // other untrusted workspace text.
  return { ok: true, content: neutralizeContextMarkup(content) };
}

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated at ${limit} characters …` : value;
}

async function readFileTool(workspacePath, args) {
  const relative = typeof args?.path === 'string' ? args.path : '';
  const resolved = resolveInsideWorkspace(workspacePath, relative);
  if (!resolved) return refuse(`"${relative}" is outside the workspace.`);
  // The same deny-list that keeps secrets out of chat context applies here. An
  // agent that could read .env would be a way around that control, not a
  // separate feature.
  if (isSensitivePath(resolved)) return refuse(`"${relative}" is excluded as a secret or binary path.`);
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    return refuse(`"${relative}" does not exist.`);
  }
  if (stat.isDirectory()) return refuse(`"${relative}" is a directory; use list_files.`);
  if (stat.size > 2 * 1024 * 1024) return refuse(`"${relative}" is too large to read.`);
  const text = await fsp.readFile(resolved, 'utf8');
  return succeed(truncate(text, MAX_FILE_CHARACTERS));
}

async function listFilesTool(workspacePath, args) {
  const relative = typeof args?.path === 'string' && args.path ? args.path : '.';
  const resolved = resolveInsideWorkspace(workspacePath, relative);
  if (!resolved) return refuse(`"${relative}" is outside the workspace.`);
  let entries;
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true });
  } catch {
    return refuse(`"${relative}" is not a readable directory.`);
  }
  const listed = entries
    .filter((entry) => !isSensitivePath(path.join(resolved, entry.name)))
    .filter((entry) => !(entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)))
    .slice(0, MAX_LISTED_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  return succeed(listed.length > 0 ? listed.join('\n') : '(empty)');
}

async function searchFilesTool(workspacePath, args) {
  const query = typeof args?.query === 'string' ? args.query : '';
  if (query.length < 2) return refuse('Search needs at least two characters.');
  const relative = typeof args?.path === 'string' && args.path ? args.path : '.';
  const root = resolveInsideWorkspace(workspacePath, relative);
  if (!root) return refuse(`"${relative}" is outside the workspace.`);

  const matches = [];
  const queue = [root];
  while (queue.length > 0 && matches.length < MAX_MATCHES) {
    const directory = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) break;
      const full = path.join(directory, entry.name);
      if (isSensitivePath(full)) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(workspacePath, full);
      if (!isLikelySourcePath(relativePath)) continue;
      let text;
      try {
        const stat = await fsp.stat(full);
        if (stat.size > 1024 * 1024) continue;
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        matches.push(`${relativePath}:${index + 1}: ${lines[index].trim().slice(0, 200)}`);
        break;
      }
    }
  }
  return succeed(matches.length > 0 ? matches.join('\n') : `No file contains ${JSON.stringify(query)}.`);
}

/**
 * Runs an approved command with no shell.
 *
 * spawn is used with an argv array, so shell metacharacters are inert: an
 * argument of "&& rm -rf ~" is passed to the program as that literal string.
 * `child_process.exec` is banned repository-wide by tools/check-source.js
 * precisely because it would reintroduce a shell here.
 */
function runCommandTool(workspacePath, argv, { timeoutMs = COMMAND_TIMEOUT_MS, spawn = childProcess.spawn, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: workspacePath,
        shell: false,
        windowsHide: true,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(refuse(`could not start ${argv[0]}: ${error.message}`));
      return;
    }

    let output = '';
    let settled = false;
    const append = (chunk) => {
      if (output.length < MAX_COMMAND_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // A command that never exits would otherwise hold the agent loop open
    // indefinitely, so the timeout escalates rather than merely giving up.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      finish(succeed(`Command timed out after ${Math.round(timeoutMs / 1000)}s.\n${truncate(output, MAX_COMMAND_OUTPUT)}`));
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => finish(refuse(`could not run ${argv[0]}: ${error.message}`)));
    child.once('close', (code, signal) =>
      finish(succeed(`exit code: ${code ?? `signal ${signal}`}\n${truncate(output, MAX_COMMAND_OUTPUT)}`))
    );
  });
}

/**
 * Executes one tool call, enforcing permission before any effect.
 */
async function executeTool({
  name,
  args,
  workspacePath,
  mode,
  rules,
  confirm,
  spawn,
  env,
  audit,
  allowWrite = false,
  applyEdit,
  writeCounter,
}) {
  if (!workspacePath) return refuse('no workspace folder is open.');
  const argv = name === 'run_command' ? (Array.isArray(args?.command) ? args.command : []) : [];
  const decision = evaluate({ mode, tool: name, argv, rules, allowWrite });
  if (!decision.allowed) {
    audit?.({ tool: name, args, outcome: 'denied', reason: decision.reason });
    return refuse(decision.reason);
  }

  // Bound the blast radius of a runaway loop before anything is written.
  if (isWriteTool(name) && writeCounter) {
    if (writeCounter.count >= MAX_WRITES_PER_TURN) {
      const reason = `this turn already changed ${MAX_WRITES_PER_TURN} files, which is the limit.`;
      audit?.({ tool: name, args, outcome: 'denied', reason });
      return refuse(reason);
    }
  }

  if (decision.needsConfirmation) {
    const approved = await confirm?.({ tool: name, argv, args });
    if (!approved) {
      audit?.({ tool: name, args, outcome: 'declined', reason: 'The user declined this action.' });
      return refuse('the user declined this action.');
    }
  }

  if (isWriteTool(name)) {
    if (typeof applyEdit !== 'function') {
      // Refusing is correct rather than falling back to a direct write: an edit
      // that bypasses the editor is not undoable, which is the property this
      // whole design exists to preserve.
      return refuse('no editor is available to apply the change, and writes never bypass the editor.');
    }
    if (writeCounter) writeCounter.count += 1;
  }

  audit?.({ tool: name, args, outcome: 'allowed', reason: '' });
  switch (name) {
    case 'read_file':
      return readFileTool(workspacePath, args);
    case 'list_files':
      return listFilesTool(workspacePath, args);
    case 'search_files':
      return searchFilesTool(workspacePath, args);
    case 'write_file':
      return writeFileTool(workspacePath, args, { applyEdit });
    case 'edit_file':
      return editFileTool(workspacePath, args, { applyEdit });
    case 'run_command':
      if (argv.length === 0) return refuse('run_command needs a non-empty argv array.');
      return runCommandTool(workspacePath, argv, { spawn, env });
    default:
      return refuse(`unknown tool "${name}".`);
  }
}

function toolSchemasFor({ allowWrite = false } = {}) {
  return allowWrite ? [...TOOL_SCHEMAS, ...WRITE_TOOL_SCHEMAS] : [...TOOL_SCHEMAS];
}

module.exports = {
  COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT,
  MAX_FILE_CHARACTERS,
  TOOL_SCHEMAS,
  WRITE_TOOL_SCHEMAS,
  executeTool,
  toolSchemasFor,
  listFilesTool,
  readFileTool,
  runCommandTool,
  searchFilesTool,
};
