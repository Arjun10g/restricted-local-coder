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

// Accelerated runtimes are keyed off the base platform and searched ahead of it.
// They are delivered out of band rather than in the VSIX: the Windows CUDA build
// unpacks to roughly a gigabyte, most of it ggml-cuda.dll and cublasLt.
const ACCELERATED_RUNTIME_KEYS = {
  'win32-x64': ['win32-x64-cuda'],
};

function acceleratedRuntimeKeys(key = getRuntimeKey()) {
  return ACCELERATED_RUNTIME_KEYS[key] ?? [];
}

// The MSVC C/C++ runtime is not part of Windows itself, unlike the Universal
// CRT. A locked-down workstation may not have it and cannot install it without
// administrator rights, so the VSIX carries these beside llama-server.exe.
// libomp140 is the LLVM OpenMP runtime that every ggml-cpu backend imports. It
// ships inside the upstream archive rather than with Windows, and an earlier
// packaging filter dropped it — which made llama-server fail to load with no
// message beyond a failed --version. Naming it here turns that into a preflight
// row that says which file is missing.
const WINDOWS_RUNTIME_LIBRARIES = [
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'libomp140.x86_64.dll',
];

function requiredSystemLibraries(platform = process.platform) {
  return platform === 'win32' ? [...WINDOWS_RUNTIME_LIBRARIES] : [];
}

// llama.cpp is built with GGML_BACKEND_DL, so each compute backend is a separate
// loadable library beside the server. A CPU-only build has none of these, and on
// such a build --n-gpu-layers is accepted and silently does nothing — which
// looks identical to a broken GPU unless it is reported.
const GPU_BACKEND_PATTERN = /ggml-(cuda|hip|vulkan|metal|sycl|opencl)/i;

/**
 * Names the GPU backends a runtime directory can actually load. An empty array
 * means the build is CPU-only, whatever the machine's hardware is.
 */
async function gpuBackends(runtimeDirectory) {
  try {
    const entries = await fsp.readdir(runtimeDirectory);
    return entries
      .filter((entry) => GPU_BACKEND_PATTERN.test(entry))
      .map((entry) => entry.match(GPU_BACKEND_PATTERN)[1].toLowerCase())
      .filter((backend, index, all) => all.indexOf(backend) === index)
      .sort();
  } catch {
    return [];
  }
}

async function directoryContains(directory, fileName) {
  try {
    const target = fileName.toLowerCase();
    const entries = await fsp.readdir(directory);
    return entries.some((entry) => entry.toLowerCase() === target);
  } catch {
    return false;
  }
}

/**
 * Report which required system libraries the runtime would fail to load.
 *
 * Windows resolves a DLL from the executable's own directory before the system
 * directories, so a library shipped in the VSIX satisfies the dependency
 * without administrator rights. An already-installed redistributable in
 * System32 satisfies it too.
 */
async function missingSystemLibraries(runtimeDirectory, platform = process.platform, environment = process.env) {
  const required = requiredSystemLibraries(platform);
  if (required.length === 0) {
    return [];
  }
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows';
  const searchPaths = [runtimeDirectory, path.join(systemRoot, 'System32')];
  const missing = [];
  for (const library of required) {
    let found = false;
    for (const directory of searchPaths) {
      if (await directoryContains(directory, library)) {
        found = true;
        break;
      }
    }
    if (!found) {
      missing.push(library);
    }
  }
  return missing;
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
  // A GPU runtime is far too large to ship inside a VSIX, so it is fetched
  // separately into its own directory. Prefer it when present and fall back to
  // the CPU build, which means a machine without it still works.
  for (const accelerated of acceleratedRuntimeKeys(key)) {
    candidates.push(path.join(extensionPath, 'runtime', accelerated, name));
  }
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
  ACCELERATED_RUNTIME_KEYS,
  WINDOWS_RUNTIME_LIBRARIES,
  acceleratedRuntimeKeys,
  defaultModelDirectory,
  getRuntimeKey,
  gpuBackends,
  isRunnableFile,
  missingSystemLibraries,
  modelPath,
  requiredSystemLibraries,
  resolveModelDirectory,
  resolveRuntimeBinary,
  runtimeFileName,
};
