'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureDir, expandHome } = require('./util');

function getRuntimeKey(platform = process.platform, architecture = process.arch) {
  const key = `${platform}-${architecture}`;
  const supported = new Set([
    'win32-x64',
    'linux-x64',
    'linux-arm64',
    'darwin-arm64',
    'darwin-x64',
  ]);
  if (!supported.has(key)) {
    throw new Error(
      `Unsupported platform/architecture ${key}. Build a llama-server binary and set localCoder.runtimePath.`
    );
  }
  return key;
}

function runtimeFileName(platform = process.platform) {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

function defaultModelDirectory(platform = process.platform, environment = process.env) {
  if (platform === 'win32') {
    const root = environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'RestrictedLocalCoder', 'models');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'RestrictedLocalCoder', 'models');
  }
  const root = environment.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'restricted-local-coder', 'models');
}

async function resolveModelDirectory(configuredPath) {
  const value = configuredPath?.trim();
  const directory = value ? path.resolve(expandHome(value)) : defaultModelDirectory();
  await ensureDir(directory);
  return directory;
}

async function isRunnableFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
    await fsp.access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

async function resolveRuntimeBinary(extensionPath, configuredPath) {
  const name = runtimeFileName();
  const candidates = [];

  if (configuredPath?.trim()) {
    const configured = path.resolve(expandHome(configuredPath.trim()));
    candidates.push(configured, path.join(configured, name));
  }

  const key = getRuntimeKey();
  candidates.push(path.join(extensionPath, 'runtime', key, name));

  for (const candidate of candidates) {
    if (await isRunnableFile(candidate)) {
      return candidate;
    }
  }

  const searched = candidates.map((candidate) => `  - ${candidate}`).join('\n');
  throw new Error(
    `No runnable llama-server binary was found. Install a platform VSIX built by this repository or set localCoder.runtimePath.\nSearched:\n${searched}`
  );
}

function modelPath(modelDirectory, profile) {
  if (!profile?.fileName || path.basename(profile.fileName) !== profile.fileName) {
    throw new Error('Invalid model file name in manifest');
  }
  return path.join(modelDirectory, profile.fileName);
}

module.exports = {
  defaultModelDirectory,
  getRuntimeKey,
  isRunnableFile,
  modelPath,
  resolveModelDirectory,
  resolveRuntimeBinary,
  runtimeFileName,
};
