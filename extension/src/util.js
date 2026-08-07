'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

function createAbortError(message = 'Operation cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

function isAbortError(error) {
  return Boolean(
    error &&
      (error.name === 'AbortError' ||
        error.code === 'ABORT_ERR' ||
        error.code === 'ERR_ABORTED')
  );
}

function sleep(milliseconds, signal) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError('milliseconds must be a non-negative finite number');
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(cleanupAndResolve, milliseconds);
    timer.unref?.();

    function cleanupAndResolve() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }

    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : createAbortError());
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return 'unknown';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit += 1;
  } while (scaled >= 1024 && unit < units.length - 1);
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[unit]}`;
}

async function ensureDir(directory) {
  await fsp.mkdir(directory, { recursive: true });
  return directory;
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, { cause: error });
  }
}

async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fsp.rename(temporary, filePath);
}

function randomSecret(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new TypeError('Secret length must be an integer of at least 16 bytes');
  }
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function expandHome(input) {
  if (typeof input !== 'string') {
    return input;
  }
  if (input === '~') {
    return require('node:os').homedir();
  }
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(require('node:os').homedir(), input.slice(2));
  }
  return input;
}

function redactUrl(input) {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid URL>';
  }
}

function truncateText(value, maxCharacters) {
  const text = String(value ?? '');
  if (!Number.isFinite(maxCharacters) || maxCharacters <= 0 || text.length <= maxCharacters) {
    return text;
  }
  const marker = '\n…[truncated]…\n';
  if (maxCharacters <= marker.length + 8) {
    return text.slice(0, maxCharacters);
  }
  const head = Math.ceil((maxCharacters - marker.length) * 0.7);
  const tail = maxCharacters - marker.length - head;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function findFreeLoopbackPort(preferredPort = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: preferredPort, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

module.exports = {
  clampInteger,
  createAbortError,
  ensureDir,
  expandHome,
  findFreeLoopbackPort,
  formatBytes,
  isAbortError,
  pathExists,
  randomSecret,
  readJson,
  redactUrl,
  safeErrorMessage,
  sleep,
  throwIfAborted,
  truncateText,
  unique,
  writeJsonAtomic,
};
