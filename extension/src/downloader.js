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

async function sha256Range(filePath, start, length, { signal, onProgress } = {}) {
  throwIfAborted(signal);
  const hash = crypto.createHash('sha256');
  let processed = 0;
  const stream = fs.createReadStream(filePath, { start, end: start + length - 1 });
  const onAbort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : createAbortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
      processed += chunk.length;
      onProgress?.({ processed, total: length, phase: 'hashing' });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (processed !== length) {
    throw new DownloadError(
      `Expected ${length} bytes at offset ${start} of ${path.basename(filePath)} but read ${processed}`
    );
  }
  return hash.digest('hex');
}

function assertPartPlan(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError('At least one model part is required');
  }
  const seen = new Set();
  const offsets = [];
  let totalBytes = 0;
  for (const [index, part] of parts.entries()) {
    const name = part?.name;
    if (typeof name !== 'string' || !name || path.basename(name) !== name) {
      throw new DownloadError(`Part ${index + 1} has an unsafe file name`);
    }
    if (seen.has(name)) {
      throw new DownloadError(`Duplicate model part name: ${name}`);
    }
    seen.add(name);
    if (!Number.isSafeInteger(part.bytes) || part.bytes <= 0) {
      throw new DownloadError(`Part ${name} has an invalid byte length`);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(part.sha256 ?? ''))) {
      throw new DownloadError(`Part ${name} has an invalid SHA-256`);
    }
    offsets.push(totalBytes);
    totalBytes += part.bytes;
  }
  return { offsets, totalBytes };
}

function partUrl(base, name) {
  const normalized = String(base).endsWith('/') ? String(base) : `${base}/`;
  return new URL(encodeURIComponent(name), normalized).toString();
}

async function appendPart(url, filePath, options) {
  const {
    partBytes,
    resumeWithin = 0,
    baseOffset = 0,
    totalBytes = null,
    prohibitedHosts = [],
    maxRedirects = 10,
    headers = {},
    signal,
    onProgress,
  } = options;
  throwIfAborted(signal);

  if (resumeWithin >= partBytes) {
    return { written: resumeWithin, restarted: false, finalUrl: url };
  }

  const requestHeaders = { ...headers };
  if (resumeWithin > 0) {
    requestHeaders.Range = `bytes=${resumeWithin}-`;
  }

  const { response, finalUrl } = await requestFollowingRedirects(url, {
    headers: requestHeaders,
    signal,
    prohibitedHosts,
    maxRedirects,
  });
  const status = response.statusCode ?? 0;

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

  let restarted = false;
  if (status === 206) {
    const range = parseContentRange(response.headers['content-range']);
    if (!range || range.start !== resumeWithin) {
      response.destroy();
      throw new DownloadError(
        `Server returned an invalid Content-Range while resuming a part at ${resumeWithin}`
      );
    }
  } else if (resumeWithin > 0) {
    // The source ignored Range. Rewrite this part from its own offset rather
    // than appending duplicate bytes.
    restarted = true;
  }

  let received = restarted ? 0 : resumeWithin;
  // Write at this part's own offset. Repairing one part must never discard the
  // parts already assembled after it.
  const writeStream = fs.createWriteStream(filePath, {
    flags: 'r+',
    start: baseOffset + received,
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
      received: baseOffset + received,
      total: totalBytes,
      resumedFrom: baseOffset + (restarted ? 0 : resumeWithin),
      url: redactUrl(finalUrl.toString()),
    });
  });

  try {
    await pipeline(response, writeStream, { signal });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  return { written: received, restarted, finalUrl: finalUrl.toString() };
}

/**
 * Assemble a model from approved parts small enough for a release-asset host.
 *
 * Parts stream straight into the destination file in order, so peak disk stays
 * at one model plus the part in flight, and peak memory stays at one stream
 * buffer. Every part is verified against its own SHA-256 so a single bad part
 * is re-fetched alone, and the assembled file is then verified against the same
 * whole-file digest the single-file path uses.
 */
async function downloadPartedModel(options) {
  const {
    parts,
    baseUrls,
    destination,
    acceptedSha256 = [],
    verifySha256 = true,
    prohibitedHosts = [],
    maxRedirects = 10,
    headers = {},
    signal,
    onProgress,
    logger,
    maxPartAttempts = 2,
  } = options ?? {};

  if (!Array.isArray(baseUrls) || baseUrls.length === 0) {
    throw new TypeError('At least one part base URL is required');
  }
  if (!destination || typeof destination !== 'string') {
    throw new TypeError('A destination path is required');
  }
  const { offsets, totalBytes } = assertPartPlan(parts);
  for (const base of baseUrls) {
    assertDownloadUrl(partUrl(base, parts[0].name), prohibitedHosts);
  }

  throwIfAborted(signal);
  await ensureDir(path.dirname(destination));
  const partPath = `${destination}.part`;

  if (await pathExists(destination)) {
    try {
      const validation = await validateGgufFile(destination, {
        expectedBytes: totalBytes,
        acceptedSha256,
        verifySha256,
        signal,
        onProgress,
      });
      return { ...validation, destination, reused: true, sourceUrl: null, parts: parts.length };
    } catch (error) {
      logger?.(`Existing model did not validate and will be replaced: ${error.message}`);
      await fsp.rename(destination, `${destination}.invalid-${Date.now()}`).catch(() => fsp.unlink(destination));
    }
  }

  if (await pathExists(partPath)) {
    if ((await fsp.stat(partPath)).size > totalBytes) {
      logger?.('Discarding an oversized partial assembly');
      await fsp.truncate(partPath, 0);
    }
  } else {
    await fsp.writeFile(partPath, '', { mode: 0o600 });
  }

  const usedSources = [];
  for (const [index, part] of parts.entries()) {
    throwIfAborted(signal);
    const start = offsets[index];
    const have = Math.min(Math.max((await fsp.stat(partPath)).size - start, 0), part.bytes);

    // A part that is fully present is repaired in place, never truncated, so
    // later parts already on disk survive and are skipped on their own turn.
    let repairing = false;
    if (have === part.bytes) {
      const existing = await sha256Range(partPath, start, part.bytes, { signal });
      if (existing.toLowerCase() === String(part.sha256).toLowerCase()) {
        logger?.(`Part ${index + 1}/${parts.length} is already present and verified`);
        continue;
      }
      logger?.(`Part ${part.name} failed verification and will be fetched again`);
      repairing = true;
    }

    let verified = false;
    const errors = [];
    for (let attempt = 1; attempt <= maxPartAttempts && !verified; attempt += 1) {
      for (const base of baseUrls) {
        throwIfAborted(signal);
        const rawUrl = partUrl(base, part.name);
        const safeUrl = redactUrl(rawUrl);
        try {
          // Only a part at the end of the file can be resumed mid-way. A part
          // being repaired in place is always rewritten in full.
          const tail = Math.min(Math.max((await fsp.stat(partPath)).size - start, 0), part.bytes);
          const resumeWithin = repairing || tail >= part.bytes ? 0 : tail;
          logger?.(`Downloading part ${index + 1}/${parts.length} (${formatBytes(part.bytes)}) from ${safeUrl}`);
          const { written } = await appendPart(rawUrl, partPath, {
            partBytes: part.bytes,
            resumeWithin,
            baseOffset: start,
            totalBytes,
            prohibitedHosts,
            maxRedirects,
            headers,
            signal,
            onProgress,
          });

          if (written !== part.bytes) {
            const error = new DownloadError(
              `Part ${part.name} produced ${formatBytes(written)}; the manifest expects ${formatBytes(part.bytes)}`
            );
            error.partVerificationFailed = true;
            throw error;
          }

          const actual = await sha256Range(partPath, start, part.bytes, { signal, onProgress });
          if (actual.toLowerCase() !== String(part.sha256).toLowerCase()) {
            const error = new DownloadError(
              `Part ${part.name} SHA-256 mismatch. Received ${actual}; expected ${part.sha256}`,
              { actualSha256: actual }
            );
            error.partVerificationFailed = true;
            throw error;
          }

          verified = true;
          usedSources.push(safeUrl);
          break;
        } catch (error) {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : createAbortError();
          }
          errors.push(`${safeUrl}: ${error.message}`);
          logger?.(`Part source failed: ${safeUrl}: ${error.message}`);
          if (error.partVerificationFailed) {
            // These bytes are known to be wrong, so the next attempt must not
            // resume from them. A network failure leaves a valid prefix instead.
            repairing = true;
          }
        }
      }
    }

    if (!verified) {
      throw new DownloadError(
        `Every approved source failed for part ${part.name}:\n${errors.map((value) => `- ${value}`).join('\n')}`
      );
    }
  }

  let validation;
  try {
    validation = await validateGgufFile(partPath, {
      expectedBytes: totalBytes,
      acceptedSha256,
      verifySha256,
      signal,
      onProgress,
    });
  } catch (error) {
    const quarantine = `${partPath}.invalid-${Date.now()}`;
    await fsp.rename(partPath, quarantine).catch(() => fsp.rm(partPath, { force: true }));
    throw new DownloadError(
      `The assembled model failed verification and was quarantined as ${path.basename(quarantine)}: ${error.message}`,
      { cause: error, modelValidationFailed: true }
    );
  }

  await fsp.rm(destination, { force: true });
  await fsp.rename(partPath, destination);
  return {
    ...validation,
    destination,
    reused: false,
    parts: parts.length,
    sourceUrl: usedSources[0] ?? null,
  };
}

module.exports = {
  DownloadError,
  GGUF_MAGIC,
  assertDownloadUrl,
  assertPartPlan,
  downloadPartedModel,
  downloadWithResume,
  parseContentRange,
  partUrl,
  sha256File,
  sha256Range,
  validateGgufFile,
};
