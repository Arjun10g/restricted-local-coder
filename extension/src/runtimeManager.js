'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');
const { LlamaClient } = require('./client');
const { resolveRuntimeBinary } = require('./paths');
const {
  clampInteger,
  findFreeLoopbackPort,
  randomSecret,
  safeErrorMessage,
  sleep,
} = require('./util');

const SECRET_KEY = 'localCoder.runtimeApiKey.v1';
const {
  automaticThreads,
  runtimeEnvironment,
  validateExtraArguments,
} = require('./runtimePolicy');

class RuntimeManager {
  constructor(context, outputChannel, modelRegistry) {
    this.context = context;
    this.output = outputChannel;
    this.modelRegistry = modelRegistry;
    this.process = null;
    this.client = null;
    this.state = 'stopped';
    this.detail = 'Runtime is stopped';
    this.port = null;
    this.profile = null;
    this.startPromise = null;
    this.stopping = false;
    this.recentOutput = [];
    this.stateEmitter = new vscode.EventEmitter();
    this.onDidChangeState = this.stateEmitter.event;
  }

  snapshot() {
    return {
      state: this.state,
      detail: this.detail,
      port: this.port,
      profile: this.profile,
      ready: this.state === 'ready' && Boolean(this.client),
    };
  }

  setState(state, detail) {
    this.state = state;
    this.detail = detail;
    this.stateEmitter.fire(this.snapshot());
  }

  config() {
    return vscode.workspace.getConfiguration('localCoder');
  }

  async secret() {
    let value = await this.context.secrets.get(SECRET_KEY);
    if (!value) {
      value = randomSecret(32);
      await this.context.secrets.store(SECRET_KEY, value);
    }
    return value;
  }

  /**
   * GPU offload and speculative decoding, both opt-out and both degrading to a
   * plain CPU run when the hardware or the drafter is absent.
   *
   * Flag names are those of the pinned tag: `--draft-max` and `--draft-min` were
   * removed upstream in favour of `--spec-draft-n-max` and `--spec-draft-n-min`,
   * so the older spellings are silently rejected.
   */
  accelerationArguments(modelFile, profile) {
    const config = this.config();
    const args = [];

    const requested = config.get('runtime.gpuLayers', 'auto');
    if (requested !== 'off') {
      // "auto" lets llama.cpp place as many layers as the device holds, which is
      // the right default when VRAM is unknown; a number pins it explicitly.
      const layers = requested === 'auto' ? '-1' : String(clampInteger(requested, 0, 999, 0));
      args.push('--n-gpu-layers', layers);
    }

    const draft = profile.draftModel;
    if (draft && config.get('runtime.enableDraftModel', true)) {
      const draftFile = path.join(path.dirname(modelFile), draft.fileName);
      // The drafter is optional, so a missing file must not stop the server.
      if (fs.existsSync(draftFile)) {
        args.push('--model-draft', draftFile);
        args.push('--spec-draft-n-max', String(clampInteger(config.get('runtime.draftMaxTokens', 16), 1, 64, 16)));
        if (requested !== 'off') {
          args.push('--n-gpu-layers-draft', '-1');
        }
      } else {
        this.output.appendLine(`[runtime] Draft model ${draft.fileName} is not installed; speculative decoding is off`);
      }
    }

    return args;
  }

  buildArguments({ modelFile, profile, port, threads }) {
    const config = this.config();
    const contextOverride = config.get('runtime.contextSize', 0);
    const contextSize = contextOverride > 0 ? contextOverride : profile.contextSize;
    const promptCacheMiB = clampInteger(config.get('runtime.promptCacheMiB', 512), 0, 4096, 512);
    const extra = validateExtraArguments(config.get('runtime.extraArguments', []));
    return [
      '--model',
      modelFile,
      '--alias',
      'local-coder',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ctx-size',
      String(contextSize),
      '--threads',
      String(threads),
      '--threads-batch',
      String(threads),
      '--batch-size',
      String(profile.batchSize),
      '--ubatch-size',
      String(profile.ubatchSize),
      '--parallel',
      '1',
      '--cache-ram',
      String(promptCacheMiB),
      '--no-cache-idle-slots',
      '--cache-type-k',
      'q8_0',
      '--cache-type-v',
      'q8_0',
      '--load-mode',
      'mmap',
      '--flash-attn',
      'auto',
      ...this.accelerationArguments(modelFile, profile),
      '--jinja',
      '--no-webui',
      '--no-agent',
      '--offline',
      '--cors-origins',
      'localhost',
      '--no-cors-credentials',
      '--no-slots',
      '--log-colors',
      'off',
      '--log-timestamps',
      ...extra,
    ];
  }

  appendProcessOutput(source, chunk) {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const formatted = `[runtime:${source}] ${line}`;
      this.output.appendLine(formatted);
      this.recentOutput.push(formatted);
      if (this.recentOutput.length > 80) this.recentOutput.shift();
    }
  }

  async start() {
    if (this.state === 'ready' && this.client) return this.client;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal()
      .catch(async (error) => {
        const child = this.process;
        if (child && child.exitCode === null) {
          this.stopping = true;
          child.kill('SIGTERM');
          await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            sleep(2000),
          ]);
          if (child.exitCode === null) child.kill('SIGKILL');
        }
        this.process = null;
        this.client = null;
        this.port = null;
        this.stopping = false;
        this.setState('error', safeErrorMessage(error));
        throw error;
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async startInternal() {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Local Coder is disabled until the workspace is trusted and reviewed.');
    }
    if (this.process) await this.stop();
    this.stopping = false;
    this.recentOutput = [];
    const profile = this.modelRegistry.getSelectedProfile();
    this.profile = profile;
    this.setState('starting', `Validating ${profile.shortName}`);

    const model = await this.modelRegistry.requireValidModel(profile);
    const runtime = await resolveRuntimeBinary(
      this.context.extensionPath,
      this.config().get('runtimePath', '')
    );
    const preferredPort = clampInteger(this.config().get('runtime.port', 0), 0, 65535, 0);
    const port = await findFreeLoopbackPort(preferredPort);
    const requestedThreads = clampInteger(this.config().get('runtime.threads', 0), 0, 256, 0);
    const threads = requestedThreads || automaticThreads();
    const apiKey = await this.secret();
    const args = this.buildArguments({
      modelFile: model.filePath,
      profile,
      port,
      threads,
    });

    this.output.appendLine(`[runtime] Starting ${runtime}`);
    this.output.appendLine(
      `[runtime] Model=${profile.id}; context=${args[args.indexOf('--ctx-size') + 1]}; threads=${threads}; port=${port}`
    );
    this.setState('starting', `Loading ${profile.shortName} on 127.0.0.1:${port}`);

    const child = childProcess.spawn(runtime, args, {
      cwd: path.dirname(model.filePath),
      env: runtimeEnvironment(apiKey, runtime),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;
    this.port = port;
    const client = new LlamaClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey,
      modelAlias: 'local-coder',
    });
    this.client = client;

    child.stdout?.on('data', (chunk) => this.appendProcessOutput('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.appendProcessOutput('stderr', chunk));
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error;
      this.output.appendLine(`[runtime] Process error: ${safeErrorMessage(error)}`);
    });
    child.once('exit', (code, signal) => {
      const expected = this.stopping;
      this.output.appendLine(`[runtime] Exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (this.process === child) {
        this.process = null;
        this.client = null;
        this.port = null;
        if (!expected) {
          const suffix = this.recentOutput.slice(-5).join('\n');
          this.setState('error', `llama-server exited unexpectedly (${code ?? signal}).${suffix ? ` See logs.` : ''}`);
        }
      }
    });

    const timeoutSeconds = clampInteger(
      this.config().get('runtime.startupTimeoutSeconds', 300),
      30,
      1800,
      300
    );
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastError = null;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`Unable to start llama-server: ${safeErrorMessage(spawnError)}`);
      }
      if (child.exitCode !== null || child.killed) {
        throw new Error(
          `llama-server exited while loading.\n${this.recentOutput.slice(-12).join('\n')}`
        );
      }
      try {
        const health = await client.health(AbortSignal.timeout(3000));
        if (health?.status === 'ok') {
          this.setState('ready', `${profile.shortName} ready on loopback`);
          return client;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(1000);
    }

    await this.stop();
    throw new Error(
      `Timed out after ${timeoutSeconds}s while loading ${profile.shortName}: ${safeErrorMessage(lastError)}\n${this.recentOutput
        .slice(-12)
        .join('\n')}`
    );
  }

  getClient() {
    if (this.state !== 'ready' || !this.client) {
      throw new Error('The local runtime is not ready. Run “Local Coder: Start Local Runtime”.');
    }
    return this.client;
  }

  async ensureReady() {
    return this.state === 'ready' && this.client ? this.client : this.start();
  }

  async stop() {
    const child = this.process;
    this.stopping = true;
    this.client = null;
    if (!child) {
      this.port = null;
      this.setState('stopped', 'Runtime is stopped');
      this.stopping = false;
      return;
    }
    this.setState('stopping', 'Stopping local runtime');
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      sleep(5000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(2000),
      ]);
    }
    if (this.process === child) this.process = null;
    this.port = null;
    this.setState('stopped', 'Runtime is stopped');
    this.stopping = false;
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async dispose() {
    await this.stop();
    this.stateEmitter.dispose();
  }
}

module.exports = { RuntimeManager };
