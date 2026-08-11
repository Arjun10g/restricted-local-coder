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
    this.lastArgumentsUsedDraft = false;
    this.draftDisabledForSession = false;
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
  /**
   * Returns the --n-gpu-layers value, or null to omit the flag entirely.
   *
   * An unparseable setting falls back to "auto" and says so, because silently
   * treating a typo as zero would look like a machine that lost its GPU.
   */
  resolveGpuLayers(requested) {
    if (requested === 'off') return null;
    if (requested === 'auto' || requested === undefined || requested === null || requested === '') {
      // -1 lets llama.cpp place as many layers as the device holds, which is the
      // right default when VRAM is unknown, and is a no-op without a GPU.
      return '-1';
    }
    const parsed = Number(requested);
    if (!Number.isFinite(parsed)) {
      this.output.appendLine(
        `[runtime] localCoder.runtime.gpuLayers is "${requested}", which is not "auto", "off", or a number; using auto`
      );
      return '-1';
    }
    return String(clampInteger(parsed, 0, 999, 0));
  }

  accelerationArguments(modelFile, profile) {
    const config = this.config();
    const args = [];

    const requested = config.get('runtime.gpuLayers', 'auto');
    const offload = this.resolveGpuLayers(requested);
    if (offload !== null) {
      args.push('--n-gpu-layers', offload);
    }

    // Records whether this launch offered a drafter, so a failed start can be
    // retried without one instead of surfacing as a broken model.
    this.lastArgumentsUsedDraft = false;

    const draft = profile.draftModel;
    if (draft && config.get('runtime.enableDraftModel', false) && !this.draftDisabledForSession) {
      const draftFile = path.join(path.dirname(modelFile), draft.fileName);
      // The drafter is optional, so a missing file must not stop the server.
      if (fs.existsSync(draftFile)) {
        this.lastArgumentsUsedDraft = true;
        args.push('--model-draft', draftFile);
        // --model-draft alone loads the drafter and never uses it: the
        // speculative type defaults to none, and llama.cpp only infers one for
        // Hugging Face sidecar downloads, never for a local path. Without this
        // the drafter costs memory and buys exactly nothing, silently.
        // The value is manifest data so a drafter of another kind needs no code
        // change.
        if (draft.specType) args.push('--spec-type', String(draft.specType));
        // A DFlash drafter spends one of its block slots on the anchor token,
        // so the usable maximum is blockSize - 1; asking for more is clamped
        // upstream with a warning.
        //
        // The ceiling is not the right default, though, and we shipped it as one
        // until it was measured. On a CPU the target's verification pass costs
        // roughly 157 ms of weight streaming plus 77 ms for every position it
        // verifies, so a 16-token block costs 5.8 single-token passes while
        // returning about 6.3 tokens -- break-even. Measured on 28 cores:
        // n-max 3 is 2.04x, n-max 15 is 1.09x greedy and an outright slowdown at
        // the profile's own temperature. Small blocks win. Upstream's default is
        // 3 for the same reason.
        const draftCeiling = Number.isInteger(draft.blockSize) ? Math.max(1, draft.blockSize - 1) : 64;
        const requestedDraft = config.get('runtime.draftMaxTokens', 3);
        args.push('--spec-draft-n-max', String(clampInteger(requestedDraft, 1, draftCeiling, Math.min(3, draftCeiling))));
        // A drafter left on the CPU while the main model is on the GPU is
        // usually slower than no speculation at all.
        if (offload !== null) {
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
      // Online repacking rewrites the quantised weights into a CPU-friendly
      // layout at load, and keeps that rewritten copy in ANONYMOUS memory --
      // measured, a full second copy of the model. On the default profile that
      // took peak resident memory from 17.0 GiB to 31.0 GiB for a 16.5 GiB
      // model, which does not fit on a 32 GB machine that is also running
      // VS Code. It bought 4.5% of generation speed and nothing at all for
      // prompt processing.
      //
      // So it is off by default and the manifest may turn it back on per
      // profile, for machines with the memory to spare.
      ...(profile.repack === true ? [] : ['--no-repack']),
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

  /**
   * Start, and if a run that offered a draft model fails, start again without
   * it.
   *
   * Speculative decoding is a throughput optimization and must never be able to
   * stop the model loading. A drafter can be rejected for reasons that are not
   * knowable in advance -- the shipped one is a different architecture from the
   * model it drafts for, and llama.cpp refuses the context it needs -- and the
   * symptom is a wall of errors that reads as though the weights are broken.
   */
  async startWithDraftFallback() {
    try {
      return await this.startInternal();
    } catch (error) {
      if (!this.lastArgumentsUsedDraft || this.draftDisabledForSession) throw error;
      this.draftDisabledForSession = true;
      this.output.appendLine(
        '[runtime] The run that included the draft model failed. Retrying without speculative decoding.'
      );
      this.output.appendLine(`[runtime] The failure was: ${safeErrorMessage(error)}`);
      const client = await this.startInternal();
      vscode.window.showWarningMessage(
        'The draft model could not be loaded, so speculative decoding is off for this session. Generation is otherwise normal. Set localCoder.runtime.enableDraftModel to false to stop trying.'
      );
      return client;
    }
  }

  async start() {
    if (this.state === 'ready' && this.client) return this.client;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startWithDraftFallback()
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
