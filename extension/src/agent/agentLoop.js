'use strict';

const { executeTool, toolSchemasFor } = require('./tools');

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
  reasoningStrength,
  spawn,
  allowWrite = false,
  applyEdit,
  allowWeb = false,
  allowedHosts = [],
  searchUrlTemplate,
}) {
  const conversation = [...messages];
  const steps = [];
  // Shared across every step of this turn, so the write cap bounds the whole
  // loop rather than resetting on each tool call.
  const writeCounter = { count: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await client.chatWithTools({
      messages: conversation,
      profile,
      tools: toolSchemasFor({ allowWrite, allowWeb }),
      reasoningStrength,
      signal,
    });

    const message = response?.message ?? {};
    const toolCalls = normalizeToolCalls(message);
    if (toolCalls.length === 0) {
      const text = String(message.content ?? '');
      // A reasoning model can spend its entire output budget on its private
      // analysis and return an empty answer with no tool call to continue from.
      // Returning '' presents that as a finished, blank reply.
      if (!text.trim() && String(response?.reasoning ?? '').trim()) {
        return {
          text: 'The model used its whole output budget reasoning and produced no answer. Raise localCoder.chat.maxOutputTokens, or ask a narrower question.',
          steps,
          stoppedAtLimit: false,
        };
      }
      return { text, steps, stoppedAtLimit: false };
    }

    // Reasoning is replayed here, and only here.
    //
    // The rule for a completed turn is to drop it: it wastes context and
    // degrades the next reply. A tool-calling sequence is the documented
    // exception -- the analysis that produced this tool call is part of the
    // still-open turn, and several model families either degrade or hard-error
    // when it is missing from the assistant message carrying tool_calls.
    // Sending it to a template that does not want it is free; the field is
    // ignored.
    const assistantTurn = {
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: message.tool_calls,
    };
    const reasoning = message.reasoning_content ?? response?.reasoning;
    if (reasoning) assistantTurn.reasoning_content = reasoning;
    conversation.push(assistantTurn);

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
          allowWrite,
          applyEdit,
          writeCounter,
          allowWeb,
          allowedHosts,
          searchUrlTemplate,
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
