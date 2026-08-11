'use strict';

const path = require('node:path');

/**
 * What the agent is allowed to do.
 *
 * Two rules govern everything here:
 *
 * 1. Commands are matched as an **argv prefix**, never as a substring of a
 *    command line. Substring matching is how allow-lists get defeated: an
 *    allowed "npm test" would also permit "npm test; rm -rf ~" if the rule were
 *    checked against a string. Nothing in this module ever joins argv into a
 *    string for matching, and nothing is ever handed to a shell.
 *
 * 2. Paths are resolved and then confirmed to be inside the workspace. A path is
 *    compared after resolution, so "../" and symlink-shaped inputs cannot walk
 *    out, and the check requires a separator so "/work/project-secrets" is not
 *    treated as inside "/work/project".
 */

// Read-only, non-mutating, and useful for answering questions about a project.
// Anything that writes, installs, or reaches the network is deliberately absent.
const DEFAULT_COMMAND_RULES = [
  ['git', 'status'],
  ['git', 'diff'],
  ['git', 'log'],
  ['git', 'show'],
  ['git', 'branch'],
  ['npm', 'test'],
  ['npm', 'run', 'test'],
  ['npm', 'run', 'lint'],
  ['node', '--test'],
  ['node', '--version'],
  ['python3', '-m', 'pytest'],
  ['cargo', 'test'],
  ['go', 'test'],
];

const MODES = new Set(['off', 'readonly', 'allowlist', 'confirm']);

/**
 * Splits a configured rule such as "npm run lint" into argv tokens. Rules are
 * authored as strings for readability in settings, but are compared as tokens.
 */
function parseRule(rule) {
  if (Array.isArray(rule)) return rule.map(String).filter(Boolean);
  return String(rule ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map(parseRule).filter((rule) => rule.length > 0);
}

/**
 * True when argv begins with every token of the rule, compared element by
 * element. Extra trailing arguments are permitted — "npm test" allows
 * "npm test --reporter=tap" — but they can never introduce a second command,
 * because there is no shell to interpret them.
 */
function matchesRule(rule, argv) {
  if (!Array.isArray(argv) || argv.length < rule.length) return false;
  for (let index = 0; index < rule.length; index += 1) {
    if (argv[index] !== rule[index]) return false;
  }
  return true;
}

function isCommandAllowed(argv, rules = DEFAULT_COMMAND_RULES) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (argv.some((argument) => typeof argument !== 'string')) return false;
  // A NUL byte truncates the string once it reaches the OS, so an argument
  // containing one cannot be reasoned about here.
  if (argv.some((argument) => argument.includes('\0'))) return false;
  return normalizeRules(rules).some((rule) => matchesRule(rule, argv));
}

/**
 * Resolves a workspace-relative path and confirms it stays inside the
 * workspace. Returns null for anything that escapes, rather than throwing, so
 * callers report a refusal rather than a stack trace.
 */
function resolveInsideWorkspace(workspacePath, candidate) {
  if (!workspacePath || typeof candidate !== 'string' || candidate === '') return null;
  if (candidate.includes('\0')) return null;
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, candidate);
  if (resolved === root) return resolved;
  // The separator matters: without it, "/work/project-secrets" would pass as
  // being inside "/work/project".
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

function normalizeMode(mode) {
  return MODES.has(mode) ? mode : 'allowlist';
}

/**
 * Decides a single tool invocation.
 *
 * Returns { allowed, needsConfirmation, reason }. Confirmation is a separate
 * outcome from permission: a tool that is not allowed can never be reached by
 * confirming it, so a prompt is only ever offered for something already
 * permitted by the mode.
 */
// Tools that change the user's files. Gated separately from command execution,
// because "may run the test suite" and "may rewrite my source" are different
// decisions and should not be bundled into one setting.
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

function isWriteTool(tool) {
  return WRITE_TOOLS.has(tool);
}

function evaluate({ mode, tool, argv, rules, allowWrite = false }) {
  const effective = normalizeMode(mode);
  if (effective === 'off') {
    return { allowed: false, needsConfirmation: false, reason: 'Agent mode is disabled.' };
  }

  if (isWriteTool(tool)) {
    // Readonly means readonly, whatever allowWrite says.
    if (effective === 'readonly') {
      return { allowed: false, needsConfirmation: false, reason: 'File editing is disabled in readonly mode.' };
    }
    if (!allowWrite) {
      return {
        allowed: false,
        needsConfirmation: false,
        reason: 'File editing is disabled. Set localCoder.agent.allowWrite to true to enable it.',
      };
    }
    // In confirm mode every write is confirmed, exactly as every command is.
    return {
      allowed: true,
      needsConfirmation: effective === 'confirm',
      reason: effective === 'confirm' ? 'Every file change requires confirmation in confirm mode.' : '',
    };
  }

  if (tool !== 'run_command') {
    // Reading is bounded by the workspace root and the secret deny-list, both
    // enforced at the tool itself rather than here.
    return { allowed: true, needsConfirmation: false, reason: '' };
  }
  if (effective === 'readonly') {
    return { allowed: false, needsConfirmation: false, reason: 'Command execution is disabled in readonly mode.' };
  }
  if (effective === 'confirm') {
    return { allowed: true, needsConfirmation: true, reason: 'Every command requires confirmation in confirm mode.' };
  }
  if (isCommandAllowed(argv, rules)) {
    return { allowed: true, needsConfirmation: false, reason: '' };
  }
  return {
    allowed: false,
    needsConfirmation: false,
    reason: `Command is not on the approved list: ${Array.isArray(argv) ? argv.join(' ') : String(argv)}`,
  };
}

module.exports = {
  DEFAULT_COMMAND_RULES,
  MODES,
  WRITE_TOOLS,
  evaluate,
  isWriteTool,
  isCommandAllowed,
  matchesRule,
  normalizeMode,
  normalizeRules,
  parseRule,
  resolveInsideWorkspace,
};
