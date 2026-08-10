'use strict';

const vscode = require('vscode');
const { ChatViewProvider } = require('./chatView');
const { ContextBuilder } = require('./contextBuilder');
const { InlineCompletionProvider } = require('./inlineCompletion');
const { ModelRegistry } = require('./modelRegistry');
const { runPreflight } = require('./preflight');
const { ensureProjectMemory } = require('./projectMemory');
const { RuntimeManager } = require('./runtimeManager');
const { isAbortError, safeErrorMessage } = require('./util');

let activeRuntime = null;

function command(handler, output) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (isAbortError(error)) return undefined;
      output.appendLine(`[command] ${error.stack ?? safeErrorMessage(error)}`);
      void vscode.window.showErrorMessage(`Local Coder: ${safeErrorMessage(error)}`);
      return undefined;
    }
  };
}

function register(context, commandId, handler, output) {
  context.subscriptions.push(vscode.commands.registerCommand(commandId, command(handler, output)));
}

function updateStatusBar(item, state) {
  const snapshots = {
    stopped: ['$(circle-outline) Local Coder', 'Local runtime is stopped'],
    starting: ['$(loading~spin) Local Coder', state.detail],
    ready: ['$(check) Local Coder', state.detail],
    stopping: ['$(loading~spin) Local Coder', state.detail],
    error: ['$(error) Local Coder', state.detail],
  };
  const [text, tooltip] = snapshots[state.state] ?? snapshots.stopped;
  item.text = text;
  item.tooltip = tooltip;
  item.backgroundColor = state.state === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  item.show();
}

async function activate(context) {
  const output = vscode.window.createOutputChannel('Restricted Local Coder', { log: true });
  context.subscriptions.push(output);
  output.appendLine(`[extension] Activating ${context.extension.packageJSON.version}`);

  const models = await new ModelRegistry(context, output).initialize();
  const runtime = new RuntimeManager(context, output, models);
  activeRuntime = runtime;
  const contextBuilder = new ContextBuilder(output);
  const chat = new ChatViewProvider(context, runtime, models, contextBuilder, output);
  const inline = new InlineCompletionProvider(runtime, models, output);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('localCoder.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, inline),
    chat,
    inline
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
  status.command = 'localCoder.openChat';
  context.subscriptions.push(status);
  updateStatusBar(status, runtime.snapshot());
  context.subscriptions.push(runtime.onDidChangeState((state) => updateStatusBar(status, state)));

  register(context, 'localCoder.openChat', () => chat.show(), output);
  register(context, 'localCoder.start', async () => {
    await runtime.start();
    await chat.show();
  }, output);
  register(context, 'localCoder.stop', async () => {
    chat.cancel();
    await runtime.stop();
  }, output);
  register(context, 'localCoder.restart', async () => {
    chat.cancel();
    await runtime.restart();
  }, output);
  register(context, 'localCoder.downloadModel', async () => {
    chat.cancel();
    await runtime.stop();
    await models.downloadSelectedModel();
    chat.postModel();
  }, output);
  register(context, 'localCoder.importModel', async () => {
    chat.cancel();
    await runtime.stop();
    await models.importModel();
    chat.postModel();
  }, output);
  register(context, 'localCoder.selectModel', async () => {
    const previous = models.getSelectedProfile().id;
    const selected = await models.selectProfile();
    if (selected && selected.id !== previous) {
      chat.cancel();
      await runtime.stop();
      chat.postModel();
    }
  }, output);
  register(context, 'localCoder.preflight', () => runPreflight(context, models), output);
  register(context, 'localCoder.askSelection', () => chat.runSelectionAction('ask'), output);
  register(context, 'localCoder.explainSelection', () => chat.runSelectionAction('explain'), output);
  register(context, 'localCoder.reviewSelection', () => chat.runSelectionAction('review'), output);
  register(context, 'localCoder.refactorSelection', () => chat.runSelectionAction('refactor'), output);
  register(context, 'localCoder.generateTests', () => chat.runSelectionAction('tests'), output);
  register(context, 'localCoder.debugSelection', () => chat.runSelectionAction('debug'), output);
  register(context, 'localCoder.insertLastResponse', () => chat.insertLastResponse(false), output);
  register(context, 'localCoder.replaceSelectionWithLastResponse', () => chat.insertLastResponse(true), output);
  register(context, 'localCoder.cancelGeneration', () => chat.cancel(), output);
  register(context, 'localCoder.showLogs', () => output.show(true), output);
  register(
    context,
    'localCoder.editProjectMemory',
    async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage('Open a folder before creating project memory.');
        return;
      }
      // Creating is 'wx', so an existing memory file is opened, never replaced.
      const { file, created } = await ensureProjectMemory(folder.uri.fsPath);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      if (created) {
        void vscode.window.showInformationMessage(
          'Created .localcoder/memory.md. It is sent with every request, so keep it short.'
        );
      }
    },
    output
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('localCoder.modelProfile')) {
        chat.postModel();
        if (runtime.snapshot().ready) {
          void vscode.window.showWarningMessage('The model profile changed. Restart Local Coder to load the new model.');
        }
      }
    })
  );

  if (vscode.workspace.getConfiguration('localCoder').get('runtime.autoStart', false)) {
    void runtime.start().catch((error) => {
      output.appendLine(`[runtime] Auto-start failed: ${safeErrorMessage(error)}`);
      void vscode.window.showWarningMessage(`Local Coder did not auto-start: ${safeErrorMessage(error)}`);
    });
  }

  output.appendLine('[extension] Ready');
}

async function deactivate() {
  if (activeRuntime) {
    await activeRuntime.dispose();
    activeRuntime = null;
  }
}

module.exports = { activate, deactivate };
