'use strict';

const vscode = require('vscode');
const { isAbortError, sleep } = require('./util');
const { isSensitivePath } = require('./contextRules');

function cleanCompletion(text) {
  let value = String(text ?? '')
    .replace(/<\|(?:fim_prefix|fim_suffix|fim_middle|fim_pad|im_end)\|>/g, '')
    .replace(/^```[^\n]*\n?/, '')
    .replace(/```\s*$/, '');
  const nul = value.indexOf('\0');
  if (nul >= 0) value = value.slice(0, nul);
  return value;
}

function removeSuffixOverlap(completion, suffix) {
  let value = completion;
  const max = Math.min(value.length, suffix.length, 200);
  for (let size = max; size >= 3; size -= 1) {
    if (value.endsWith(suffix.slice(0, size))) {
      value = value.slice(0, -size);
      break;
    }
  }
  return value;
}

class InlineCompletionProvider {
  constructor(runtimeManager, modelRegistry, outputChannel) {
    this.runtime = runtimeManager;
    this.models = modelRegistry;
    this.output = outputChannel;
    this.controller = null;
    this.lastKey = null;
    this.lastValue = null;
    this.lastAt = 0;
  }

  async provideInlineCompletionItems(document, position, _context, token) {
    const config = vscode.workspace.getConfiguration('localCoder');
    if (!config.get('inlineCompletions.enabled', false)) return undefined;
    if (!this.runtime.snapshot().ready) return undefined;
    const profile = this.models.getSelectedProfile();
    if (!profile.fim) return undefined;
    if (document.uri.scheme !== 'file' || document.isClosed) return undefined;
    if (isSensitivePath(document.uri.fsPath)) return undefined;
    if (document.getText().length > 1024 * 1024) return undefined;

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (/^\s*(?:\/\/|#|--|\*)\s*$/.test(linePrefix)) return undefined;

    this.controller?.abort(new DOMException('Superseded inline completion', 'AbortError'));
    const controller = new AbortController();
    this.controller = controller;
    const cancellationSubscription = token.onCancellationRequested(() =>
      controller.abort(new DOMException('VS Code cancelled completion', 'AbortError'))
    );

    const debounce = config.get('inlineCompletions.debounceMs', 450);
    try {
      await sleep(debounce, controller.signal);
      const offset = document.offsetAt(position);
      const full = document.getText();
      const prefix = full.slice(Math.max(0, offset - 8000), offset);
      const suffix = full.slice(offset, Math.min(full.length, offset + 4000));
      const key = `${document.uri.toString()}|${document.version}|${offset}|${prefix.slice(-400)}|${suffix.slice(0, 200)}`;
      if (this.lastKey === key && Date.now() - this.lastAt < 30_000) {
        if (!this.lastValue) return undefined;
        return [new vscode.InlineCompletionItem(this.lastValue, new vscode.Range(position, position))];
      }

      const client = this.runtime.getClient();
      let completion = await client.completeFim({
        prefix,
        suffix,
        profile,
        signal: controller.signal,
        maxTokens: config.get('inlineCompletions.maxTokens', 96),
      });
      completion = removeSuffixOverlap(cleanCompletion(completion), suffix);
      if (completion.length > 4000) completion = completion.slice(0, 4000);
      if (!completion || completion.trim() === '') {
        this.lastKey = key;
        this.lastValue = null;
        this.lastAt = Date.now();
        return undefined;
      }
      this.lastKey = key;
      this.lastValue = completion;
      this.lastAt = Date.now();
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) {
        this.output.appendLine(`[inline] ${error.message}`);
      }
      return undefined;
    } finally {
      cancellationSubscription.dispose();
      if (this.controller === controller) this.controller = null;
    }
  }

  dispose() {
    this.controller?.abort(new DOMException('Provider disposed', 'AbortError'));
  }
}

module.exports = {
  InlineCompletionProvider,
  cleanCompletion,
  removeSuffixOverlap,
};
