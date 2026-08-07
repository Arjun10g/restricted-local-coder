'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const {
  createAbortError,
  ensureDir,
  formatBytes,
  pathExists,
  redactUrl,
  throwIfAborted,
} = require('./util');

const GGUF_MAGIC = Buffer.from([0x47, 0x47, 0x55, 0x46]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class DownloadError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DownloadError';
    Object.assign(this, details);
  }
}

function assertDownloadUrl(input, prohibitedHosts = []) {
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new DownloadError(`Invalid download URL: ${input}`, { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new DownloadError(`Unsupported download protocol: ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new DownloadError('Model downloads require HTTPS except for a loopback development server');
  }
  for (const prohibited of prohibitedHosts) {
    const blocked = String(prohibited).toLowerCase().replace(/\.$/, '');
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      throw new DownloadError(`Blocked model host: ${hostname}`);
    }
  }
  return url;
}

function requestOnce(url, { headers, signal }) {
  throwIfAborted(signal);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'RestrictedLocalCoder/0.1 (+VSCode)',
          Accept: 'application/octet-stream,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          ...headers,
        },
      },
      resolve
    );

    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : createAbortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    request.once('close', () => signal?.removeEventListener('abort', onAbort));
    request.once('error', reject);
    request.setTimeout(120_000, () => {
      request.destroy(new DownloadError(`Timed out while connecting to ${redactUrl(url.toString())}`));
    });
    request.end();
  });
}

async function requestFollowingRedirects(input, options = {}) {
  let url = assertDownloadUrl(input, options.prohibitedHosts);
  const maxRedirects = options.maxRedirects ?? 10;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await requestOnce(url, options);
    if (!REDIRECTS.has(response.statusCode)) {
      return { response, finalUrl: url };
    }
    const location = response.headers.location;
    response.resume();
    if (!location) {
      throw new DownloadError(`Redirect from ${redactUrl(url.toString())} did not include Location`);
    }
    if (redirect === maxRedirects) {
      throw new DownloadError(`Too many redirects while downloading ${redactUrl(input)}`);
    }
    url = assertDownloadUrl(new URL(location, url).toString(), options.prohibitedHosts);
  }
  throw new DownloadError(`Unable to resolve download URL ${redactUrl(input)}`);
}

function parseContentRange(value) {
  if (!value) {
    return null;
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value).trim());
  if (!match) {
    return null;
  }
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

async function sha256File(filePath, { signal, onProgress } = {}) {
  throwIfAborted(signal);
  const stat = await fsp.stat(filePath);
  const hash = crypto.createHash('sha256');
  let processed = 0;
  const stream = fs.createReadStream(filePath);
  const onAbort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : createAbortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
      processed += chunk.length;
      onProgress?.({ processed, total: stat.size, phase: 'hashing' });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return hash.digest('hex');
}

async function readMagic(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(GGUF_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length ? buffer : null;
  } finally {
    await handle.close();
  }
}

async function validateGgufFile(filePath, options = {}) {
  const {
    expectedBytes = null,
    acceptedSha256 = [],
    verifySha256 = true,
    minimumBytes = 4,
    signal,
    onProgress,
  } = options;
  throwIfAborted(signal);

  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new DownloadError(`${filePath} is not a regular file`);
  }
  if (stat.size < minimumBytes) {
    throw new DownloadError(`File is too small to be a GGUF model: ${formatBytes(stat.size)}`);
  }
  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && stat.size !== expectedBytes) {
    throw new DownloadError(
      `Model size mismatch: expected ${formatBytes(expectedBytes)}, found ${formatBytes(stat.size)}`,
      { expectedBytes, actualBytes: stat.size }
    );
  }

  const magic = await readMagic(filePath);
  if (!magic?.equals(GGUF_MAGIC)) {
    throw new DownloadError('File does not begin with the GGUF magic bytes');
  }

  let sha256 = null;
  if (verifySha256) {
    if (!Array.isArray(acceptedSha256) || acceptedSha256.length === 0) {
      throw new DownloadError('SHA-256 verification was requested, but the model profile has no approved hashes');
    }
    sha256 = await sha256File(filePath, { signal, onProgress });
    const approved = acceptedSha256.map((value) => String(value).toLowerCase());
    if (!approved.includes(sha256.toLowerCase())) {
      throw new DownloadError(
        `SHA-256 mismatch. Received ${sha256}; expected one of ${approved.join(', ')}`,
        { actualSha256: sha256, acceptedSha256: approved }
      );
    }
  }

  return { size: stat.size, sha256 };
}

async function downloadSingleUrl(url, partPath, options) {
  const {
    signal,
    onProgress,
    prohibitedHosts = [],
    maxRedirects = 10,
    headers = {},
  } = options;
  throwIfAborted(signal);
  await ensureDir(path.dirname(partPath));

  let resumeOffset = 0;
  try {
    resumeOffset = (await fsp.stat(partPath)).size;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const requestHeaders = { ...headers };
  if (resumeOffset > 0) {
    requestHeaders.Range = `bytes=${resumeOffset}-`;
  }

  const { response, finalUrl } = await requestFollowingRedirects(url, {
    headers: requestHeaders,
    signal,
    prohibitedHosts,
    maxRedirects,
  });
  const status = response.statusCode ?? 0;

  if (status === 416 && resumeOffset > 0) {
    response.resume();
    return { downloadedBytes: resumeOffset, resumed: true, finalUrl: finalUrl.toString(), completeCandidate: true };
  }

  if (status !== 200 && status !== 206) {
    const snippets = [];
    let bytes = 0;
    for await (const chunk of response) {
      if (bytes >= 4096) break;
      const slice = chunk.subarray(0, Math.min(chunk.length, 4096 - bytes));
      snippets.push(slice);
      bytes += slice.length;
    }
    const body = Buffer.concat(snippets).toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
    throw new DownloadError(
      `HTTP ${status} from ${redactUrl(finalUrl.toString())}${body ? `: ${body}` : ''}`,
      { statusCode: status, url: redactUrl(finalUrl.toString()) }
    );
  }

  let append = status === 206 && resumeOffset > 0;
  if (status === 206) {
    const range = parseContentRange(response.headers['content-range']);
    if (!range || range.start !== resumeOffset) {
      response.destroy();
      throw new DownloadError(
        `Server returned an invalid Content-Range while resuming at ${resumeOffset}`
      );
    }
  } else if (resumeOffset > 0) {
    // The source ignored Range. Restart safely rather than appending duplicate bytes.
    append = false;
    resumeOffset = 0;
  }

  const contentLength = Number(response.headers['content-length']);
  const responseBytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
  const contentRange = parseContentRange(response.headers['content-range']);
  const total = contentRange?.total ?? (responseBytes === null ? null : resumeOffset + responseBytes);
  let received = resumeOffset;
  const writeStream = fs.createWriteStream(partPath, {
    flags: append ? 'a' : 'w',
    mode: 0o600,
  });

  const onAbort = () => {
    const error = signal.reason instanceof Error ? signal.reason : createAbortError();
    response.destroy(error);
    writeStream.destroy(error);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  response.on('data', (chunk) => {
    received += chunk.length;
    onProgress?.({
      phase: 'downloading',
      received,
      total,
      resumedFrom: resumeOffset,
      url: redactUrl(finalUrl.toString()),
    });
  });

  try {
    await pipeline(response, writeStream, { signal });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  return {
    downloadedBytes: received,
    resumed: append,
    finalUrl: finalUrl.toString(),
    completeCandidate: true,
  };
}

async function downloadWithResume(options) {
  const {
    urls,
    destination,
    expectedBytes = null,
    acceptedSha256 = [],
    verifySha256 = true,
    prohibitedHosts = [],
    signal,
    onProgress,
    logger,
  } = options ?? {};

  if (!Array.isArray(urls) || urls.length === 0) {
    throw new TypeError('At least one download URL is required');
  }
  if (!destination || typeof destination !== 'string') {
    throw new TypeError('A destination path is required');
  }

  throwIfAborted(signal);
  await ensureDir(path.dirname(destination));
  const partPath = `${destination}.part`;

  if (await pathExists(destination)) {
    try {
      const validation = await validateGgufFile(destination, {
        expectedBytes,
        acceptedSha256,
        verifySha256,
        signal,
        onProgress,
      });
      return { ...validation, destination, reused: true, sourceUrl: null };
    } catch (error) {
      logger?.(`Existing model did not validate and will be replaced: ${error.message}`);
      await fsp.rename(destination, `${destination}.invalid-${Date.now()}`).catch(() => fsp.unlink(destination));
    }
  }

  const errors = [];
  for (const rawUrl of urls) {
    throwIfAborted(signal);
    const safeUrl = redactUrl(rawUrl);
    try {
      logger?.(`Downloading model from ${safeUrl}`);
      const result = await downloadSingleUrl(rawUrl, partPath, {
        ...options,
        prohibitedHosts,
      });
      let validation;
      try {
        validation = await validateGgufFile(partPath, {
          expectedBytes,
          acceptedSha256,
          verifySha256,
          signal,
          onProgress,
        });
      } catch (error) {
        error.modelValidationFailed = true;
        throw error;
      }
      await fsp.rm(destination, { force: true });
      await fsp.rename(partPath, destination);
      return {
        ...validation,
        destination,
        reused: false,
        resumed: result.resumed,
        sourceUrl: redactUrl(result.finalUrl),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : createAbortError();
      }
      if (error.modelValidationFailed && (await pathExists(partPath))) {
        const invalidPath = `${partPath}.invalid-${Date.now()}`;
        await fsp.rename(partPath, invalidPath).catch(() => fsp.rm(partPath, { force: true }));
        logger?.(`Invalid completed download was quarantined as ${path.basename(invalidPath)}`);
      }
      errors.push(`${safeUrl}: ${error.message}`);
      logger?.(`Model source failed: ${safeUrl}: ${error.message}`);
    }
  }

  throw new DownloadError(`Every approved model source failed:\n${errors.map((value) => `- ${value}`).join('\n')}`);
}

module.exports = {
  DownloadError,
  GGUF_MAGIC,
  assertDownloadUrl,
  downloadWithResume,
  parseContentRange,
  sha256File,
  validateGgufFile,
};
