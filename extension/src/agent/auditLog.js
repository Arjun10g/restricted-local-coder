'use strict';

/**
 * A record of everything the agent was permitted or refused.
 *
 * This exists so that "what did it do?" has an answer that does not depend on
 * scrolling a chat transcript. It is written to the output channel, which is
 * already the place runtime events go, and kept in memory for the session so a
 * summary can be shown on demand.
 *
 * Arguments are summarized rather than dumped: a refused read of a secret path
 * should record the path, never the contents, and a long command should not
 * flood the log.
 */
const MAX_ENTRIES = 500;
const MAX_SUMMARY = 300;

function summarizeArguments(tool, args) {
  if (tool === 'run_command') {
    const argv = Array.isArray(args?.command) ? args.command : [];
    return argv.join(' ').slice(0, MAX_SUMMARY);
  }
  if (args && typeof args === 'object') {
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
      parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    return parts.join(' ').slice(0, MAX_SUMMARY);
  }
  return String(args ?? '').slice(0, MAX_SUMMARY);
}

class AuditLog {
  constructor(outputChannel) {
    this.output = outputChannel;
    this.entries = [];
  }

  record({ tool, args, outcome, reason }) {
    const entry = {
      at: new Date().toISOString(),
      tool,
      summary: summarizeArguments(tool, args),
      outcome,
      reason: reason ?? '',
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.output?.appendLine(
      `[agent] ${entry.outcome.toUpperCase()} ${entry.tool} ${entry.summary}${entry.reason ? ` — ${entry.reason}` : ''}`
    );
    return entry;
  }

  /** A recorder bound to this log, shaped for executeTool's `audit` hook. */
  recorder() {
    return (entry) => this.record(entry);
  }

  summary() {
    if (this.entries.length === 0) return 'No agent tool calls have been made this session.';
    const counts = this.entries.reduce((totals, entry) => {
      totals[entry.outcome] = (totals[entry.outcome] ?? 0) + 1;
      return totals;
    }, {});
    const header = Object.entries(counts)
      .map(([outcome, count]) => `${count} ${outcome}`)
      .join(', ');
    const lines = this.entries.slice(-50).map((entry) => `${entry.at} ${entry.outcome} ${entry.tool} ${entry.summary}`);
    return `${header}\n\n${lines.join('\n')}`;
  }
}

module.exports = { AuditLog, MAX_ENTRIES, summarizeArguments };
