'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseToolArguments, runAgentLoop } = require('../src/agent/agentLoop');

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-loop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
}

/** A client that replays scripted assistant messages, one per turn. */
function scriptedClient(turns) {
  let index = 0;
  return {
    calls: [],
    async chatWithTools(request) {
      this.calls.push(request);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return { message: turn };
    },
  };
}

function toolCall(name, args, id = 'call_1') {
  return { tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] };
}

test('a plain answer with no tool calls returns immediately', async (t) => {
  const client = scriptedClient([{ content: 'The answer is 42.' }]);
  const result = await runAgentLoop({
    client,
    messages: [{ role: 'user', content: 'hi' }],
    workspacePath: workspace(t),
    mode: 'allowlist',
  });
  assert.equal(result.text, 'The answer is 42.');
  assert.equal(result.steps.length, 0);
  assert.equal(result.stoppedAtLimit, false);
  assert.equal(client.calls.length, 1);
});

test('a tool result is fed back and the final answer is returned', async (t) => {
  const root = workspace(t);
  await fsp.writeFile(path.join(root, 'app.js'), 'const answer = 42;');
  const client = scriptedClient([toolCall('read_file', { path: 'app.js' }), { content: 'It sets answer to 42.' }]);

  const result = await runAgentLoop({
    client,
    messages: [{ role: 'user', content: 'what does app.js do?' }],
    workspacePath: root,
    mode: 'allowlist',
  });

  assert.equal(result.text, 'It sets answer to 42.');
  assert.deepEqual(result.steps.map((step) => [step.name, step.ok]), [['read_file', true]]);
  const followUp = client.calls[1].messages;
  const toolMessage = followUp.at(-1);
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.match(toolMessage.content, /answer = 42/);
});

test('the loop is bounded and says so rather than presenting partial work as final', async (t) => {
  const root = workspace(t);
  await fsp.writeFile(path.join(root, 'app.js'), 'x');
  // A model stuck in a loop: it asks for the same tool forever.
  const client = scriptedClient([toolCall('read_file', { path: 'app.js' })]);

  const result = await runAgentLoop({
    client,
    messages: [{ role: 'user', content: 'go' }],
    workspacePath: root,
    mode: 'allowlist',
    maxSteps: 3,
  });

  assert.equal(result.stoppedAtLimit, true);
  assert.equal(result.steps.length, 3, 'must not exceed the step cap');
  assert.match(result.text, /Stopped after 3 tool steps/);
});

test('a denied command never runs, and the refusal is fed back so the model can adapt', async (t) => {
  const root = workspace(t);
  let spawned = false;
  const client = scriptedClient([
    toolCall('run_command', { command: ['rm', '-rf', '/'] }),
    { content: 'I cannot run that.' },
  ]);
  const audit = [];

  const result = await runAgentLoop({
    client,
    messages: [{ role: 'user', content: 'delete everything' }],
    workspacePath: root,
    mode: 'allowlist',
    audit: (entry) => audit.push(entry),
    spawn: () => {
      spawned = true;
      throw new Error('must not spawn');
    },
  });

  assert.equal(spawned, false);
  assert.equal(result.steps[0].ok, false);
  assert.equal(audit.at(-1).outcome, 'denied');
  assert.match(client.calls[1].messages.at(-1).content, /Refused/);
});

test('malformed tool arguments produce a readable refusal, not a crash', async (t) => {
  const client = {
    calls: 0,
    async chatWithTools() {
      this.calls += 1;
      if (this.calls === 1) {
        return { message: { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{not json' } }] } };
      }
      return { message: { content: 'Understood.' } };
    },
  };

  const result = await runAgentLoop({
    client,
    messages: [{ role: 'user', content: 'go' }],
    workspacePath: workspace(t),
    mode: 'allowlist',
  });
  assert.equal(result.text, 'Understood.');
  assert.equal(result.steps[0].ok, false);
});

test('tool arguments are parsed defensively', () => {
  assert.deepEqual(parseToolArguments('{"path":"a.js"}'), { path: 'a.js' });
  assert.deepEqual(parseToolArguments({ path: 'a.js' }), { path: 'a.js' });
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments('"a string"'), {}, 'a non-object JSON value is not arguments');
  assert.equal(parseToolArguments('{oops'), null, 'unparseable arguments are distinguishable from empty ones');
});

test('several tool calls in one turn are each permission-checked', async (t) => {
  const root = workspace(t);
  await fsp.writeFile(path.join(root, 'app.js'), 'ok');
  await fsp.writeFile(path.join(root, '.env'), 'SECRET=1');
  const client = scriptedClient([
    {
      tool_calls: [
        { id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'app.js' }) } },
        { id: 'b', function: { name: 'read_file', arguments: JSON.stringify({ path: '.env' }) } },
      ],
    },
    { content: 'done' },
  ]);

  const result = await runAgentLoop({
    client,
    messages: [{ role: 'user', content: 'read both' }],
    workspacePath: root,
    mode: 'allowlist',
  });

  assert.deepEqual(result.steps.map((step) => step.ok), [true, false]);
  const fedBack = client.calls[1].messages.filter((message) => message.role === 'tool');
  assert.equal(fedBack.length, 2);
  assert.ok(!fedBack[1].content.includes('SECRET=1'), 'the secret must not reach the prompt');
});

test('the audit log records outcomes without recording file contents', () => {
  const { AuditLog, summarizeArguments } = require('../src/agent/auditLog');
  const lines = [];
  const log = new AuditLog({ appendLine: (line) => lines.push(line) });

  log.record({ tool: 'read_file', args: { path: '.env' }, outcome: 'denied', reason: 'excluded path' });
  log.record({ tool: 'run_command', args: { command: ['npm', 'test'] }, outcome: 'allowed', reason: '' });

  assert.equal(log.entries.length, 2);
  assert.match(lines[0], /DENIED read_file path=\.env/);
  assert.match(lines[1], /ALLOWED run_command npm test/);
  assert.match(log.summary(), /1 denied|1 allowed/);

  // Only the request is summarized; a tool result never enters the log.
  assert.equal(summarizeArguments('run_command', { command: ['git', 'status'] }), 'git status');
  assert.ok(summarizeArguments('read_file', { path: 'x'.repeat(1000) }).length <= 310);
});
