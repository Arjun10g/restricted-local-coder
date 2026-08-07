'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertDownloadUrl,
  downloadWithResume,
  validateGgufFile,
} = require('../src/downloader');

function payload(size = 1024 * 1024) {
  const result = crypto.randomBytes(size);
  Buffer.from('GGUF').copy(result, 0);
  return result;
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function temporaryDirectory() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'local-coder-test-'));
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/model.gguf`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('resumes a partial GGUF and verifies its approved SHA-256', async (t) => {
  const data = payload();
  const partialBytes = 128 * 1024;
  let observedRange = null;
  const source = await serve((request, response) => {
    observedRange = request.headers.range ?? null;
    const match = /^bytes=(\d+)-$/.exec(observedRange ?? '');
    const start = match ? Number(match[1]) : 0;
    response.statusCode = match ? 206 : 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', data.length - start);
    if (match) response.setHeader('Content-Range', `bytes ${start}-${data.length - 1}/${data.length}`);
    response.end(data.subarray(start));
  });
  t.after(source.close);

  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'model.gguf');
  await fsp.writeFile(`${destination}.part`, data.subarray(0, partialBytes));

  const result = await downloadWithResume({
    urls: [source.url],
    destination,
    expectedBytes: data.length,
    acceptedSha256: [digest(data)],
    verifySha256: true,
    prohibitedHosts: ['huggingface.co'],
  });

  assert.equal(observedRange, `bytes=${partialBytes}-`);
  assert.equal(result.resumed, true);
  assert.deepEqual(await fsp.readFile(destination), data);
});

test('restarts safely when a source ignores the Range request', async (t) => {
  const data = payload(256 * 1024);
  const source = await serve((_request, response) => {
    response.statusCode = 200;
    response.setHeader('Content-Length', data.length);
    response.end(data);
  });
  t.after(source.close);

  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'model.gguf');
  await fsp.writeFile(`${destination}.part`, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(4092, 7)]));

  const result = await downloadWithResume({
    urls: [source.url],
    destination,
    expectedBytes: data.length,
    acceptedSha256: [digest(data)],
  });
  assert.equal(result.resumed, false);
  assert.deepEqual(await fsp.readFile(destination), data);
});

test('GGUF validation rejects a normal file with the wrong header', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'not-a-model.gguf');
  await fsp.writeFile(file, Buffer.from('NOPE payload'));
  await assert.rejects(validateGgufFile(file, { verifySha256: false }), /GGUF magic/);
});

test('download URL policy blocks prohibited hosts, subdomains, and cleartext public HTTP', () => {
  assert.throws(
    () => assertDownloadUrl('https://cdn-lfs.huggingface.co/a.gguf', ['huggingface.co']),
    /Blocked model host/
  );
  assert.throws(
    () => assertDownloadUrl('http://models.example.com/a.gguf', []),
    /require HTTPS/
  );
  assert.doesNotThrow(() => assertDownloadUrl('http://127.0.0.1:8080/a.gguf', []));
  assert.doesNotThrow(() => assertDownloadUrl('https://www.modelscope.cn/a.gguf', ['huggingface.co']));
});
