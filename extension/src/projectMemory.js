'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { neutralizeContextMarkup } = require('./contextRules');

// Standing project facts a developer wants applied to every request: the build
// command, the test runner, house conventions. It lives in the workspace on
// purpose, so a team can commit and review it — unlike a chat transcript, which
// is private to one machine.
const MEMORY_DIRECTORY = '.localcoder';
const MEMORY_FILE = 'memory.md';
const MAX_MEMORY_CHARACTERS = 8000;

function memoryPath(workspacePath) {
  return path.join(workspacePath, MEMORY_DIRECTORY, MEMORY_FILE);
}

const TEMPLATE = `# Project memory

Notes here are included with every Local Coder request. Keep it short — it is
sent on every message and competes with your code for the context window.

Good things to record: the build and test commands, the language version, house
conventions a newcomer would get wrong, and directories to leave alone.

## Commands

- Build:
- Test:

## Conventions

-
`;

/**
 * Reads the workspace memory file.
 *
 * Its contents are authored by whoever can write the repository, which is not
 * necessarily the person running the model, so it is treated as untrusted data
 * exactly like any other workspace file: markup is neutralized and it is
 * labelled as data in the prompt rather than appended to the system message.
 */
async function readProjectMemory(workspacePath) {
  if (!workspacePath) return null;
  let raw;
  try {
    raw = await fsp.readFile(memoryPath(workspacePath), 'utf8');
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bounded =
    trimmed.length > MAX_MEMORY_CHARACTERS
      ? `${trimmed.slice(0, MAX_MEMORY_CHARACTERS)}\n… project memory truncated …`
      : trimmed;
  return neutralizeContextMarkup(bounded);
}

async function ensureProjectMemory(workspacePath) {
  const file = memoryPath(workspacePath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    // 'wx' fails if it exists, so an existing file is never overwritten.
    await fsp.writeFile(file, TEMPLATE, { flag: 'wx' });
    return { file, created: true };
  } catch (error) {
    if (error?.code === 'EEXIST') return { file, created: false };
    throw error;
  }
}

module.exports = {
  MAX_MEMORY_CHARACTERS,
  MEMORY_DIRECTORY,
  MEMORY_FILE,
  TEMPLATE,
  ensureProjectMemory,
  memoryPath,
  readProjectMemory,
};
