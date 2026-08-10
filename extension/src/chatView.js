'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');
const { isAbortError, safeErrorMessage } = require('./util');
const { isSensitivePath } = require('./contextRules');
const { ConversationStore } = require('./conversationStore');
const { availableHistoryTokens, selectHistory } = require('./historyBudget');

function nonce() {
  return crypto.randomBytes(18).toString('base64url');
}

function extractCode(response) {
  const text = String(response ?? '').trim();
  const fenced = /```[^\n]*\n([\s\S]*?)```/m.exec(text);
  return (fenced?.[1] ?? text).replace(/\s+$/, '');
}

class ChatViewProvider {
  constructor(context, runtimeManager, modelRegistry, contextBuilder, outputChannel) {
    this.context = context;
    this.runtime = runtimeManager;
    this.models = modelRegistry;
    this.contextBuilder = contextBuilder;
    this.output = outputChannel;
    this.view = null;
    this.history = [];
    this.lastResponse = '';
    this.activeController = null;
    this.store = new ConversationStore(context.globalStorageUri?.fsPath ?? context.globalStoragePath, outputChannel);
    this.restored = false;
    this.runtimeSubscription = this.runtime.onDidChangeState((state) => this.postStatus(state));
  }

  workspacePath() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  persistenceEnabled() {
    return vscode.workspace.getConfiguration('localCoder').get('chat.persistHistory', false);
  }

  /**
   * Loads a previous transcript once per session. Persistence is off by default,
   * so this is normally a no-op; when it is on, a failure to read must not stop
   * the chat from opening.
   */
  async restoreHistory() {
    if (this.restored) return;
    this.restored = true;
    if (!this.persistenceEnabled()) return;
    try {
      const stored = await this.store.load(this.workspacePath());
      if (stored.length > 0) {
        this.history = stored;
        this.output.appendLine(`[chat] Restored ${stored.length} stored message(s) for this workspace`);
        this.post({ type: 'restored', count: stored.length });
      }
    } catch (error) {
      this.output.appendLine(`[chat] Could not restore history: ${safeErrorMessage(error)}`);
    }
  }

  async persistHistory() {
    if (!this.persistenceEnabled()) return;
    try {
      await this.store.save(this.workspacePath(), this.history);
    } catch (error) {
      this.output.appendLine(`[chat] Could not persist history: ${safeErrorMessage(error)}`);
    }
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        try {
          await this.handleMessage(message);
        } catch (error) {
          this.post({ type: 'error', message: safeErrorMessage(error) });
          this.output.appendLine(`[chat] ${error.stack ?? error.message}`);
        }
      },
      undefined,
      this.context.subscriptions
    );
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = null;
    });
    this.postStatus(this.runtime.snapshot());
    this.postModel();
    void this.restoreHistory();
  }

  async show() {
    await vscode.commands.executeCommand('localCoder.chat.focus');
  }

  post(message) {
    void this.view?.webview.postMessage(message);
  }

  postStatus(state = this.runtime.snapshot()) {
    this.post({ type: 'status', status: state });
  }

  postModel() {
    const profile = this.models.getSelectedProfile();
    this.post({
      type: 'model',
      model: {
        id: profile.id,
        name: profile.shortName,
        quantization: profile.quantization,
        size: profile.approximateSizeGiB,
        warning: profile.warning,
      },
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'ready':
        this.postStatus();
        this.postModel();
        break;
      case 'send': {
        const prompt = String(message.prompt ?? '').trim();
        if (!prompt) return;
        if (prompt.length > 12000) {
          throw new Error('Chat input is limited to 12,000 characters; put larger source text in a workspace file.');
        }
        try {
          await this.ask(prompt);
        } catch (error) {
          // ask() already posts a request-scoped error card to the webview.
          this.output.appendLine(`[chat] ${error.stack ?? error.message}`);
        }
        break;
      }
      case 'cancel':
        this.cancel();
        break;
      case 'start':
        await this.runtime.start();
        break;
      case 'stop':
        this.cancel();
        await this.runtime.stop();
        break;
      case 'download':
        await vscode.commands.executeCommand('localCoder.downloadModel');
        break;
      case 'selectModel':
        await vscode.commands.executeCommand('localCoder.selectModel');
        break;
      case 'preflight':
        await vscode.commands.executeCommand('localCoder.preflight');
        break;
      case 'clear':
        this.cancel();
        this.history = [];
        this.lastResponse = '';
        // Clearing must remove the stored transcript too, whatever the current
        // setting says. Leaving a file behind that a later session would restore
        // would make "clear" untrue.
        await this.store.clear(this.workspacePath()).catch((error) => {
          this.output.appendLine(`[chat] Could not remove stored history: ${safeErrorMessage(error)}`);
        });
        this.post({ type: 'cleared' });
        break;
      case 'setup': {
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(symbol-parameter) Select model profile', command: 'localCoder.selectModel' },
            { label: '$(cloud-download) Download or repair model', command: 'localCoder.downloadModel' },
            { label: '$(folder-opened) Import approved GGUF', command: 'localCoder.importModel' },
            { label: '$(checklist) Run preflight', command: 'localCoder.preflight' },
          ],
          { title: 'Restricted Local Coder setup' }
        );
        if (choice) await vscode.commands.executeCommand(choice.command);
        break;
      }
      case 'insert':
        await this.insertLastResponse(false);
        break;
      default:
        break;
    }
  }

  /**
   * Prior turns that fit alongside the system prompt, this request, and room for
   * the reply. The budget follows the profile's context window rather than a
   * fixed character count, which was wasteful on a 16K profile and unsafe on an
   * 8K one.
   */
  boundedHistory({ systemText = '', userText = '' } = {}) {
    const config = vscode.workspace.getConfiguration('localCoder');
    const maxTurns = config.get('chat.maxHistoryTurns', 6);
    const profile = this.models.getSelectedProfile();
    const contextOverride = config.get('runtime.contextSize', 0);
    const budget = availableHistoryTokens({
      contextSize: contextOverride > 0 ? contextOverride : profile.contextSize,
      systemText,
      userText,
      maxOutputTokens: profile.maxOutputTokens,
    });
    return selectHistory(this.history, budget, maxTurns);
  }

  async ask(prompt, options = {}) {
    if (this.activeController) {
      throw new Error('A generation is already running. Cancel it before sending another request.');
    }
    await this.show().catch(() => undefined);
    const controller = new AbortController();
    this.activeController = controller;
    const requestId = crypto.randomUUID();
    let assistant = '';

    this.post({ type: 'user', id: requestId, text: prompt });
    this.post({ type: 'assistantStart', id: requestId });
    try {
      const client = await this.runtime.ensureReady();
      const context = await this.contextBuilder.build(prompt, options);
      if (context.sources.length > 0) {
        this.post({ type: 'sources', id: requestId, sources: context.sources });
      }
      const messages = [
        { role: 'system', content: context.system },
        ...this.boundedHistory({ systemText: context.system, userText: context.user }),
        { role: 'user', content: context.user },
      ];
      const result = await client.chatStream({
        messages,
        profile: this.models.getSelectedProfile(),
        signal: controller.signal,
        onToken: (token) => {
          assistant += token;
          this.post({ type: 'assistantToken', id: requestId, token });
        },
      });
      assistant = result.text;
      this.lastResponse = assistant;
      this.history.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: assistant }
      );
      await this.persistHistory();
      this.post({ type: 'assistantDone', id: requestId, usage: result.usage ?? null });
      return assistant;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        this.post({ type: 'assistantCancelled', id: requestId });
        return '';
      }
      this.post({ type: 'assistantError', id: requestId, message: safeErrorMessage(error) });
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  cancel() {
    this.activeController?.abort(new DOMException('Generation cancelled', 'AbortError'));
  }

  async runSelectionAction(action) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      throw new Error('Select code in an editor first.');
    }
    if (isSensitivePath(editor.document.uri.fsPath)) {
      throw new Error('This file is excluded by the secret-path policy. Copy only the non-secret code you need into a normal source file.');
    }
    const prompts = {
      explain: 'Explain the selected code precisely. Cover its data flow, assumptions, side effects, complexity, and any non-obvious behavior.',
      review: 'Review the selected code. List concrete correctness, security, reliability, concurrency, maintainability, and test-coverage findings in priority order. Then provide a minimal patch for material issues.',
      refactor: 'Refactor the selected code while preserving observable behavior and public interfaces. Return the replacement code first, followed by a concise rationale and risks.',
      tests: 'Generate production-quality tests for the selected code using the project’s apparent test framework. Cover normal cases, boundaries, failures, and regression risks. State any assumptions.',
      debug: 'Debug the selected code. Identify the most likely root cause, explain how to verify it, and provide the smallest safe correction plus a regression test.',
    };
    let prompt = prompts[action];
    if (action === 'ask') {
      prompt = await vscode.window.showInputBox({
        title: 'Ask Local Coder about the selected code',
        prompt: 'The selection and nearby code will be supplied as local context.',
        placeHolder: 'What should I change or understand?',
        ignoreFocusOut: true,
      });
      if (!prompt) return null;
    }
    return this.ask(prompt, { editor });
  }

  async insertLastResponse(replaceSelection) {
    if (!this.lastResponse) {
      throw new Error('There is no completed response to insert.');
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('Open a writable editor first.');
    const text = extractCode(this.lastResponse);
    const success = await editor.edit((editBuilder) => {
      if (replaceSelection) {
        editBuilder.replace(editor.selection, text);
      } else {
        editBuilder.insert(editor.selection.active, text);
      }
    });
    if (!success) throw new Error('VS Code could not apply the edit.');
  }

  html(webview) {
    const scriptNonce = nonce();
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'localcoder.svg'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <title>Restricted Local Coder</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    .shell { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; min-height: 260px; }
    header { padding: 10px 12px; border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border)); background: var(--vscode-sideBar-background); }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .brand img { width: 22px; height: 22px; }
    .brand-text { min-width: 0; flex: 1; }
    .title { font-weight: 650; line-height: 1.15; }
    .model { color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; margin-top: 2px; }
    .status-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 9px; }
    .status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-disabledForeground); flex: 0 0 auto; }
    .dot.ready { background: var(--vscode-testing-iconPassed); }
    .dot.starting, .dot.stopping { background: var(--vscode-charts-yellow); }
    .dot.error { background: var(--vscode-testing-iconFailed); }
    .status-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .toolbar { display: flex; gap: 4px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 3px; padding: 4px 7px; cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    .messages { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
    .empty { margin: auto; max-width: 300px; text-align: center; color: var(--vscode-descriptionForeground); line-height: 1.45; padding: 24px 8px; }
    .empty strong { color: var(--vscode-foreground); display: block; margin-bottom: 5px; }
    .message { display: grid; gap: 4px; }
    .role { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
    .bubble { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.46; padding: 9px 10px; border-radius: 5px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border, transparent); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .message.user .bubble { border-left: 3px solid var(--vscode-focusBorder); }
    .message.error .bubble { border-left: 3px solid var(--vscode-testing-iconFailed); color: var(--vscode-errorForeground); }
    .sources { color: var(--vscode-descriptionForeground); font-size: 10px; overflow-wrap: anywhere; }
    .composer { border-top: 1px solid var(--vscode-panel-border); padding: 9px; display: grid; gap: 7px; background: var(--vscode-sideBar-background); }
    textarea { width: 100%; min-height: 76px; max-height: 230px; resize: vertical; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; outline: none; }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    .composer-actions { display: flex; justify-content: space-between; gap: 8px; }
    .left, .right { display: flex; gap: 5px; }
    .privacy { font-size: 10px; color: var(--vscode-descriptionForeground); padding: 0 1px; }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">
        <img src="${iconUri}" alt="">
        <div class="brand-text">
          <div class="title">Restricted Local Coder</div>
          <div class="model" id="model">Loading model profile…</div>
        </div>
      </div>
      <div class="status-row">
        <div class="status" title="The inference server is reachable only on this machine.">
          <span class="dot" id="dot"></span><span class="status-label" id="status">Stopped</span>
        </div>
        <div class="toolbar">
          <button id="start" title="Start local runtime">Start</button>
          <button id="stop" title="Stop local runtime">Stop</button>
          <button id="more" title="Model and preflight actions">Setup</button>
        </div>
      </div>
    </header>
    <main class="messages" id="messages">
      <div class="empty" id="empty"><strong>Your code stays local.</strong>Ask about the active project, or select code and use the editor’s Local Coder commands. The model cannot run shell commands or edit files autonomously.</div>
    </main>
    <section class="composer">
      <textarea id="prompt" aria-label="Message" placeholder="Ask about the active codebase…"></textarea>
      <div class="privacy">Local loopback inference · bounded workspace context · no cloud fallback</div>
      <div class="composer-actions">
        <div class="left">
          <button id="clear">Clear</button>
          <button id="insert" title="Insert the first code block from the last answer">Insert code</button>
        </div>
        <div class="right">
          <button id="cancel" disabled>Cancel</button>
          <button class="primary" id="send">Send</button>
        </div>
      </div>
    </section>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const cancel = document.getElementById('cancel');
    const status = document.getElementById('status');
    const dot = document.getElementById('dot');
    const model = document.getElementById('model');
    const active = new Map();

    function post(type, extra = {}) { vscode.postMessage({ type, ...extra }); }
    function scroll() { messages.scrollTop = messages.scrollHeight; }
    function removeEmpty() { document.getElementById('empty')?.remove(); }
    function messageElement(role, text, id) {
      removeEmpty();
      const root = document.createElement('article');
      root.className = 'message ' + role;
      if (id) root.dataset.id = id;
      const label = document.createElement('div');
      label.className = 'role';
      label.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Local Coder';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text || '';
      root.append(label, bubble);
      messages.append(root);
      scroll();
      return { root, bubble };
    }
    function setBusy(value) {
      send.disabled = value;
      cancel.disabled = !value;
      prompt.disabled = value;
    }
    function setupMenu() { post('setup'); }

    send.addEventListener('click', () => {
      const value = prompt.value.trim();
      if (!value) return;
      prompt.value = '';
      post('send', { prompt: value });
    });
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        send.click();
      }
    });
    cancel.addEventListener('click', () => post('cancel'));
    document.getElementById('start').addEventListener('click', () => post('start'));
    document.getElementById('stop').addEventListener('click', () => post('stop'));
    document.getElementById('more').addEventListener('click', setupMenu);
    document.getElementById('clear').addEventListener('click', () => post('clear'));
    document.getElementById('insert').addEventListener('click', () => post('insert'));

    window.addEventListener('message', (event) => {
      const data = event.data;
      switch (data.type) {
        case 'status':
          status.textContent = data.status.detail || data.status.state;
          dot.className = 'dot ' + data.status.state;
          break;
        case 'model':
          model.textContent = data.model.name + ' · ' + data.model.quantization + ' · ~' + data.model.size + ' GiB';
          model.title = data.model.warning || '';
          break;
        case 'user':
          messageElement('user', data.text, data.id);
          setBusy(true);
          break;
        case 'assistantStart': {
          const element = messageElement('assistant', '', data.id);
          active.set(data.id, element);
          setBusy(true);
          break;
        }
        case 'assistantToken': {
          const element = active.get(data.id);
          if (element) { element.bubble.textContent += data.token; scroll(); }
          break;
        }
        case 'sources': {
          const element = active.get(data.id);
          if (element && Array.isArray(data.sources) && data.sources.length) {
            const sources = document.createElement('div');
            sources.className = 'sources';
            sources.textContent = 'Context: ' + data.sources.join(', ');
            element.root.append(sources);
          }
          break;
        }
        case 'assistantDone':
          active.delete(data.id); setBusy(false); prompt.focus(); break;
        case 'assistantCancelled': {
          const element = active.get(data.id);
          if (element && !element.bubble.textContent) element.bubble.textContent = '[Cancelled]';
          active.delete(data.id); setBusy(false); break;
        }
        case 'assistantError': {
          const element = active.get(data.id);
          if (element) { element.root.classList.add('error'); element.bubble.textContent = data.message; }
          else messageElement('error', data.message);
          active.delete(data.id); setBusy(false); break;
        }
        case 'error':
          messageElement('error', data.message); setBusy(false); break;
        case 'cleared':
          messages.replaceChildren();
          const placeholder = document.createElement('div');
          placeholder.className = 'empty';
          placeholder.id = 'empty';
          placeholder.textContent = 'Conversation cleared. Local runtime state is unchanged.';
          messages.append(placeholder);
          break;
      }
    });
    post('ready');
  </script>
</body>
</html>`;
  }

  dispose() {
    this.cancel();
    this.runtimeSubscription.dispose();
  }
}

module.exports = { ChatViewProvider, extractCode };
