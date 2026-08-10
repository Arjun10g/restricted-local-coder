'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readJson, writeJsonAtomic } = require('./util');

// Conversations were memory-only by design, and persisting them is a real
// privacy change: a transcript on disk outlives the editor session and can
// contain quoted source. Persistence is therefore opt-in, capped, and written
// outside the workspace so it can never be committed, indexed by the retrieval
// pass, or read back as "workspace context".
const SCHEMA_VERSION = 1;
const MAX_PERSISTED_MESSAGES = 200;
const MAX_PERSISTED_CHARACTERS = 400_000;

/**
 * A conversation belongs to a workspace, but its transcript is keyed by a digest
 * of the workspace path rather than the path itself, so the storage directory
 * does not enumerate what a user has been working on.
 */
function conversationKey(workspacePath) {
  const value = typeof workspacePath === 'string' && workspacePath ? workspacePath : '(no-workspace)';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const clean = [];
  for (const message of messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (typeof message.content !== 'string' || message.content === '') continue;
    clean.push({ role: message.role, content: message.content });
  }
  // Keep the most recent tail, then trim by characters so one enormous reply
  // cannot make the file unbounded.
  const recent = clean.slice(-MAX_PERSISTED_MESSAGES);
  let characters = 0;
  const bounded = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    characters += recent[index].content.length;
    if (characters > MAX_PERSISTED_CHARACTERS) break;
    bounded.unshift(recent[index]);
  }
  return bounded;
}

class ConversationStore {
  constructor(storageDirectory, outputChannel) {
    this.storageDirectory = storageDirectory;
    this.output = outputChannel;
  }

  fileFor(workspacePath) {
    return path.join(this.storageDirectory, 'conversations', `${conversationKey(workspacePath)}.json`);
  }

  /**
   * Returns the stored messages, or an empty array for anything unreadable.
   * A corrupt or hand-edited transcript must not stop the chat from opening.
   */
  async load(workspacePath) {
    const file = this.fileFor(workspacePath);
    try {
      const payload = await readJson(file);
      if (payload?.schemaVersion !== SCHEMA_VERSION) return [];
      return sanitizeMessages(payload.messages);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.output?.appendLine(`[conversation] Ignoring unreadable transcript: ${error.message}`);
      }
      return [];
    }
  }

  async save(workspacePath, messages) {
    const bounded = sanitizeMessages(messages);
    if (bounded.length === 0) {
      await this.clear(workspacePath);
      return 0;
    }
    // writeJsonAtomic creates the file 0o600 and renames into place, so a
    // half-written transcript is never observable.
    await writeJsonAtomic(this.fileFor(workspacePath), {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      messages: bounded,
    });
    return bounded.length;
  }

  async clear(workspacePath) {
    await fsp.rm(this.fileFor(workspacePath), { force: true });
  }
}

module.exports = {
  ConversationStore,
  MAX_PERSISTED_CHARACTERS,
  MAX_PERSISTED_MESSAGES,
  SCHEMA_VERSION,
  conversationKey,
  sanitizeMessages,
};
