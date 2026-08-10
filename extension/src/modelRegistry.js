'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {
  assertDownloadUrl,
  assertPartPlan,
  downloadPartedModel,
  downloadWithResume,
  partUrl,
  validateGgufFile,
} = require('./downloader');
const { modelPath, resolveModelDirectory } = require('./paths');
const { ensureDir, formatBytes, readJson, safeErrorMessage } = require('./util');

const VALIDATION_CACHE_KEY = 'localCoder.modelValidation.v1';

class ModelRegistry {
  constructor(context, outputChannel) {
    this.context = context;
    this.output = outputChannel;
    this.manifestPath = path.join(context.extensionPath, 'models', 'manifest.json');
    this.manifest = null;
  }

  async initialize() {
    this.manifest = await readJson(this.manifestPath);
    this.validateManifest(this.manifest);
    return this;
  }

  validateManifest(manifest) {
    if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.models) || manifest.models.length === 0) {
      throw new Error('The bundled model manifest is missing or unsupported');
    }
    const ids = new Set();
    const prohibitedHosts = manifest.prohibitedHosts ?? [];
    for (const model of manifest.models) {
      if (!model.id || ids.has(model.id)) {
        throw new Error(`Duplicate or missing model id: ${model.id}`);
      }
      ids.add(model.id);
      if (!model.fileName || path.basename(model.fileName) !== model.fileName || !model.fileName.endsWith('.gguf')) {
        throw new Error(`Unsafe GGUF file name in profile ${model.id}`);
      }
      if (!Array.isArray(model.acceptedSha256) || model.acceptedSha256.length === 0) {
        throw new Error(`Profile ${model.id} does not have an approved SHA-256`);
      }
      for (const hash of model.acceptedSha256) {
        if (!/^[a-f0-9]{64}$/i.test(hash)) {
          throw new Error(`Invalid SHA-256 in profile ${model.id}`);
        }
      }
      for (const url of model.downloadUrls ?? []) {
        assertDownloadUrl(url, prohibitedHosts);
      }
      if (model.draftModel) {
        const draft = model.draftModel;
        if (!draft.fileName || path.basename(draft.fileName) !== draft.fileName || !draft.fileName.endsWith('.gguf')) {
          throw new Error(`Unsafe draft model file name in profile ${model.id}`);
        }
        if (draft.fileName === model.fileName) {
          throw new Error(`Profile ${model.id} points its draft model at the main weights`);
        }
        if (!/^[a-f0-9]{64}$/i.test(draft.sha256 ?? '')) {
          throw new Error(`Draft model in profile ${model.id} does not have an approved SHA-256`);
        }
        for (const url of draft.downloadUrls ?? []) {
          assertDownloadUrl(url, prohibitedHosts);
        }
      }
      if (model.parts) {
        const { totalBytes } = assertPartPlan(model.parts.files);
        if (!Array.isArray(model.parts.baseUrls) || model.parts.baseUrls.length === 0) {
          throw new Error(`Profile ${model.id} declares parts without an approved base URL`);
        }
        for (const base of model.parts.baseUrls) {
          assertDownloadUrl(partUrl(base, model.parts.files[0].name), prohibitedHosts);
        }
        if (Number.isSafeInteger(model.expectedBytes) && model.expectedBytes !== totalBytes) {
          throw new Error(`Profile ${model.id} part sizes do not sum to its expected byte count`);
        }
      }
    }
    if (!ids.has(manifest.defaultProfile)) {
      throw new Error('The default model profile is not present in the manifest');
    }
  }

  configuration() {
    return vscode.workspace.getConfiguration('localCoder');
  }

  profiles() {
    return [...this.manifest.models];
  }

  getProfile(id) {
    const profileId = id || this.configuration().get('modelProfile') || this.manifest.defaultProfile;
    const profile = this.manifest.models.find((item) => item.id === profileId);
    if (!profile) {
      throw new Error(`Unknown model profile: ${profileId}`);
    }
    return profile;
  }

  getSelectedProfile() {
    return this.getProfile();
  }

  async getModelDirectory() {
    return resolveModelDirectory(this.configuration().get('modelDirectory', ''));
  }

  async getModelPath(profile = this.getSelectedProfile()) {
    return modelPath(await this.getModelDirectory(), profile);
  }

  async selectProfile() {
    const selectedId = this.getSelectedProfile().id;
    const choice = await vscode.window.showQuickPick(
      this.profiles().map((profile) => ({
        label: profile.displayName,
        description: `${profile.approximateSizeGiB} GiB · ${profile.tier}`,
        detail: profile.warning,
        profile,
        picked: profile.id === selectedId,
      })),
      {
        title: 'Select an approved local coding model',
        placeHolder: 'The 2-bit Qwen3-Coder 30B-A3B profile is recommended for 32 GB RAM.',
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
    if (!choice) return null;
    await this.configuration().update('modelProfile', choice.profile.id, vscode.ConfigurationTarget.Global);
    return choice.profile;
  }

  licenseKey(profile) {
    return `localCoder.acceptedLicense.${profile.id}.${profile.license}`;
  }

  async ensureLicenseAccepted(profile) {
    if (this.context.globalState.get(this.licenseKey(profile), false)) {
      return true;
    }
    const accepted = await vscode.window.showWarningMessage(
      `${profile.shortName} is licensed under ${profile.license}. Confirm that your organization permits this model and license before acquiring the weights.`,
      { modal: true },
      'Accept and continue'
    );
    if (accepted !== 'Accept and continue') {
      return false;
    }
    await this.context.globalState.update(this.licenseKey(profile), true);
    return true;
  }

  buildDownloadUrls(profile) {
    const config = this.configuration();
    const urls = [];
    const mirror = config.get('modelMirrorBaseUrl', '').trim();
    if (mirror) {
      let base;
      try {
        base = new URL(mirror.endsWith('/') ? mirror : `${mirror}/`);
      } catch (error) {
        throw new Error(`localCoder.modelMirrorBaseUrl is invalid: ${error.message}`);
      }
      const url = new URL(encodeURIComponent(profile.fileName), base).toString();
      assertDownloadUrl(url, this.manifest.prohibitedHosts ?? []);
      urls.push(url);
    }
    if (config.get('network.allowPublicModelDownload', true)) {
      urls.push(...(profile.downloadUrls ?? []));
    }
    return [...new Set(urls)];
  }

  buildPartBaseUrls(profile) {
    const config = this.configuration();
    const bases = [];
    const mirror = config.get('modelMirrorBaseUrl', '').trim();
    if (mirror) {
      bases.push(mirror.endsWith('/') ? mirror : `${mirror}/`);
    }
    if (config.get('network.allowPublicModelDownload', true)) {
      bases.push(...(profile.parts?.baseUrls ?? []));
    }
    const unique = [...new Set(bases)];
    for (const base of unique) {
      assertDownloadUrl(partUrl(base, profile.parts.files[0].name), this.manifest.prohibitedHosts ?? []);
    }
    return unique;
  }

  expectedBytesFor(profile) {
    if (Number.isSafeInteger(profile.expectedBytes) && profile.expectedBytes > 0) {
      return profile.expectedBytes;
    }
    if (profile.parts?.files?.length) {
      return assertPartPlan(profile.parts.files).totalBytes;
    }
    return null;
  }

  /**
   * The drafter is a second GGUF that lives beside the weights, so it is
   * expressed as a minimal profile and reuses the same mirror resolution,
   * resume, and digest machinery rather than growing a parallel download path.
   */
  draftProfileFor(profile) {
    const draft = profile?.draftModel;
    if (!draft) return null;
    return {
      id: `${profile.id}#draft`,
      shortName: `${profile.shortName} drafter`,
      fileName: draft.fileName,
      acceptedSha256: [draft.sha256],
      expectedBytes: draft.expectedBytes,
      downloadUrls: draft.downloadUrls ?? [],
      license: profile.license,
      optional: draft.optional !== false,
    };
  }

  async validateDraftModel(profile = this.getSelectedProfile()) {
    const draft = this.draftProfileFor(profile);
    if (!draft) return null;
    return this.validateModel(draft, { full: false });
  }

  /**
   * Acquiring the drafter must never fail the run: speculative decoding is a
   * throughput optimization, and the runtime already falls back to plain
   * decoding when the file is absent.
   */
  async downloadDraftModel(profile, progress, signal) {
    const draft = this.draftProfileFor(profile);
    if (!draft) return null;
    const existing = await this.validateModel(draft, { full: false });
    if (existing.valid) {
      this.output.appendLine(`[model] Draft model ${draft.fileName} is already present and verified`);
      return existing;
    }
    const urls = this.buildDownloadUrls(draft);
    if (urls.length === 0) {
      this.output.appendLine(`[model] No enabled source for draft model ${draft.fileName}; speculative decoding stays off`);
      return null;
    }
    const destination = await this.getModelPath(draft);
    progress?.report({ message: `Acquiring optional draft model ${draft.fileName}` });
    const result = await downloadWithResume({
      urls,
      destination,
      expectedBytes: this.expectedBytesFor(draft),
      acceptedSha256: draft.acceptedSha256,
      verifySha256: true,
      prohibitedHosts: this.manifest.prohibitedHosts ?? [],
      signal,
      logger: (message) => this.output.appendLine(`[model:draft] ${message}`),
      onProgress: (state) => {
        if (state.phase === 'downloading') {
          progress?.report({
            message: `Draft model: ${formatBytes(state.received ?? 0)}${state.total ? ` / ${formatBytes(state.total)}` : ''}`,
          });
        }
      },
    });
    await this.updateValidationCache(draft, destination, result);
    return result;
  }

  cacheFor(profileId) {
    const cache = this.context.globalState.get(VALIDATION_CACHE_KEY, {});
    return cache?.[profileId] ?? null;
  }

  async updateValidationCache(profile, filePath, result) {
    const stat = await fsp.stat(filePath);
    const cache = this.context.globalState.get(VALIDATION_CACHE_KEY, {});
    cache[profile.id] = {
      filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: result.sha256 ?? null,
      validatedAt: new Date().toISOString(),
    };
    await this.context.globalState.update(VALIDATION_CACHE_KEY, cache);
  }

  async validateModel(profile = this.getSelectedProfile(), { full = false, signal, onProgress } = {}) {
    const filePath = await this.getModelPath(profile);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return { valid: false, missing: true, filePath };
      throw error;
    }

    const cached = this.cacheFor(profile.id);
    const cacheMatches =
      cached &&
      cached.filePath === filePath &&
      cached.size === stat.size &&
      Math.abs(cached.mtimeMs - stat.mtimeMs) < 1 &&
      cached.sha256 &&
      profile.acceptedSha256.includes(cached.sha256);
    const verifySha256 = full || !cacheMatches;

    try {
      const result = await validateGgufFile(filePath, {
        expectedBytes: this.expectedBytesFor(profile),
        acceptedSha256: profile.acceptedSha256,
        verifySha256,
        signal,
        onProgress,
      });
      if (verifySha256) {
        await this.updateValidationCache(profile, filePath, result);
      }
      return {
        valid: true,
        filePath,
        size: result.size,
        sha256: result.sha256 ?? cached?.sha256 ?? null,
        usedCachedHash: !verifySha256,
      };
    } catch (error) {
      return { valid: false, missing: false, filePath, error };
    }
  }

  async requireValidModel(profile = this.getSelectedProfile(), options = {}) {
    const result = await this.validateModel(profile, options);
    if (result.valid) return result;
    if (result.missing) {
      throw new Error(
        `${profile.shortName} is not installed. Run “Local Coder: Download or Repair Model” or import the approved GGUF file.`
      );
    }
    throw new Error(`The installed model failed validation: ${safeErrorMessage(result.error)}`);
  }

  async downloadSelectedModel() {
    const profile = this.getSelectedProfile();
    if (!(await this.ensureLicenseAccepted(profile))) return null;
    const partBases = profile.parts?.files?.length ? this.buildPartBaseUrls(profile) : [];
    const urls = this.buildDownloadUrls(profile);
    if (partBases.length === 0 && urls.length === 0) {
      throw new Error(
        'No model source is enabled. Configure an approved internal mirror, enable public ModelScope download, or import an existing GGUF.'
      );
    }
    const destination = await this.getModelPath(profile);
    const controller = new AbortController();

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Acquiring ${profile.shortName}`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort(new Error('Model acquisition cancelled')));
        let lastReceived = 0;
        let lastPercent = 0;
        const shared = {
          destination,
          acceptedSha256: profile.acceptedSha256,
          verifySha256: true,
          prohibitedHosts: this.manifest.prohibitedHosts ?? [],
          signal: controller.signal,
          logger: (message) => this.output.appendLine(`[model] ${message}`),
          onProgress: (state) => {
            if (state.phase === 'downloading') {
              const received = state.received ?? 0;
              const total = state.total;
              let increment;
              if (total) {
                const percent = Math.min(99, (received / total) * 100);
                increment = Math.max(0, percent - lastPercent);
                lastPercent = percent;
              }
              const delta = Math.max(0, received - lastReceived);
              lastReceived = received;
              progress.report({
                increment,
                message: total
                  ? `${formatBytes(received)} / ${formatBytes(total)}`
                  : `${formatBytes(received)} downloaded (+${formatBytes(delta)})`,
              });
            } else if (state.phase === 'hashing') {
              progress.report({
                message: `Verifying SHA-256: ${formatBytes(state.processed)} / ${formatBytes(state.total)}`,
              });
            }
          },
        };
        const result =
          partBases.length > 0
            ? await downloadPartedModel({ ...shared, parts: profile.parts.files, baseUrls: partBases })
            : await downloadWithResume({ ...shared, urls, expectedBytes: this.expectedBytesFor(profile) });
        await this.updateValidationCache(profile, destination, result);

        // The weights are already verified at this point, so a drafter problem
        // is reported and stepped over rather than discarding the large download.
        let draftResult = null;
        if (profile.draftModel && this.configuration().get('runtime.enableDraftModel', true)) {
          try {
            draftResult = await this.downloadDraftModel(profile, progress, controller.signal);
          } catch (error) {
            this.output.appendLine(`[model] Optional draft model failed: ${safeErrorMessage(error)}`);
            vscode.window.showWarningMessage(
              `${profile.shortName} is ready, but its optional draft model could not be acquired. Generation will run without speculative decoding.`
            );
          }
        }

        progress.report({ increment: 100, message: 'Verified and ready' });
        vscode.window.showInformationMessage(
          `${profile.shortName} is verified and ready.${draftResult ? ' The draft model is installed, so speculative decoding is available.' : ''}`
        );
        return result;
      }
    );
  }

  async importModel() {
    const profile = this.getSelectedProfile();
    if (!(await this.ensureLicenseAccepted(profile))) return null;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: `Import the approved GGUF for ${profile.shortName}`,
      filters: { 'GGUF models': ['gguf'] },
    });
    if (!picked?.[0]) return null;
    const source = picked[0].fsPath;
    const destination = await this.getModelPath(profile);
    const partPath = `${destination}.part`;
    if (path.resolve(source) !== path.resolve(destination)) {
      await ensureDir(path.dirname(destination));
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Copying ${profile.shortName}`,
          cancellable: false,
        },
        async () => {
          await fsp.copyFile(source, partPath, fs.constants.COPYFILE_FICLONE ?? 0).catch(async () => {
            await fsp.copyFile(source, partPath);
          });
        }
      );
    }
    const candidate = path.resolve(source) === path.resolve(destination) ? source : partPath;
    let result;
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Verifying ${profile.shortName}`,
          cancellable: false,
        },
        async (progress) =>
          validateGgufFile(candidate, {
            expectedBytes: this.expectedBytesFor(profile),
            acceptedSha256: profile.acceptedSha256,
            verifySha256: true,
            onProgress: (state) => {
              if (state.phase === 'hashing') {
                progress.report({
                  message: `${formatBytes(state.processed)} / ${formatBytes(state.total)}`,
                });
              }
            },
          })
      );
    } catch (error) {
      if (candidate === partPath) {
        const quarantine = `${partPath}.invalid-${Date.now()}`;
        await fsp.rename(partPath, quarantine).catch(() => fsp.rm(partPath, { force: true }));
        this.output.appendLine(`[model] Rejected import quarantined at ${quarantine}`);
      }
      throw error;
    }
    if (candidate === partPath) {
      await fsp.rm(destination, { force: true });
      await fsp.rename(partPath, destination);
    }
    await this.updateValidationCache(profile, destination, result);
    vscode.window.showInformationMessage(`${profile.shortName} was imported and verified.`);
    return { ...result, destination };
  }
}

module.exports = { ModelRegistry };
