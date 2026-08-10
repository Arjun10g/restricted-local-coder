'use strict';

const { TOOL_SCHEMAS, executeTool } = require('./tools');

const DEFAULT_MAX_STEPS = 8;

/**
 * Drives a bounded tool-calling loop.
 *
 * The loop is deliberately finite. A local model that mis-reads a tool result
 * can otherwise retry forever, and every step costs a full prompt evaluation on
 * hardware where that is measured in seconds. Reaching the cap is reported to
 * the model and to the user rather than being retried silently.
 *
 * This module performs no permission checks of its own: every effect goes
 * through executeTool, so there is exactly one place where permission is
 * decided and one place that can be audited.
 */
function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A model that emits malformed JSON gets a refusal it can read and correct,
    // rather than an exception that ends the conversation.
    return null;
  }
}

function normalizeToolCalls(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls
    .filter((call) => call?.function?.name)
    .map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function.name,
      rawArguments: call.function.arguments,
    }));
}

async function runAgentLoop({
  client,
  messages,
  profile,
  workspacePath,
  mode,
  rules,
  confirm,
  audit,
  signal,
  maxSteps = DEFAULT_MAX_STEPS,
  onEvent,
  spawn,
}) {
  const conversation = [...messages];
  const steps = [];

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await client.chatWithTools({
      messages: conversation,
      profile,
      tools: TOOL_SCHEMAS,
      signal,
    });

    const message = response?.message ?? {};
    const toolCalls = normalizeToolCalls(message);
    if (toolCalls.length === 0) {
      return { text: String(message.content ?? ''), steps, stoppedAtLimit: false };
    }

    conversation.push({
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: message.tool_calls,
    });

    for (const call of toolCalls) {
      const args = parseToolArguments(call.rawArguments);
      onEvent?.({ type: 'toolStart', name: call.name, args });

      let result;
      if (args === null) {
        result = { ok: false, content: 'Refused: arguments were not valid JSON. Send a JSON object.' };
        audit?.({ tool: call.name, args: call.rawArguments, outcome: 'invalid', reason: 'unparseable arguments' });
      } else {
        result = await executeTool({
          name: call.name,
          args,
          workspacePath,
          mode,
          rules,
          confirm,
          audit,
          spawn,
        });
      }

      steps.push({ name: call.name, args, ok: result.ok });
      onEvent?.({ type: 'toolEnd', name: call.name, ok: result.ok, content: result.content });
      conversation.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
  }

  // The cap was reached with the model still asking for tools. Say so plainly
  // instead of presenting a partial investigation as a finished answer.
  return {
    text: `Stopped after ${maxSteps} tool steps without reaching an answer. The work so far is above; ask a narrower question or raise localCoder.agent.maxSteps.`,
    steps,
    stoppedAtLimit: true,
  };
}

module.exports = { DEFAULT_MAX_STEPS, normalizeToolCalls, parseToolArguments, runAgentLoop };
