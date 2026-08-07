'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertPartPlan, downloadPartedModel, partUrl } = require('../src/downloader');
const { splitFile } = require('../../tools/split-model');

const MODEL_NAME = 'test-model.gguf';

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Build a GGUF-shaped payload split into `count` equal parts. */
function plan(partSize = 8 * 1024, count = 3) {
  const data = crypto.randomBytes(partSize * count);
  Buffer.from('GGUF').copy(data, 0);
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const slice = data.subarray(index * partSize, (index + 1) * partSize);
    parts.push({
      name: `${MODEL_NAME}.part-${String(index + 1).padStart(3, '0')}`,
      bytes: slice.length,
      sha256: digest(slice),
      body: slice,
    });
  }
  return { data, parts: parts.map(({ body, ...rest }) => rest), bodies: new Map(parts.map((p) => [p.name, p.body])) };
}

async function temporaryDirectory() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'local-coder-parts-'));
}

/** Serve parts by name with Range support, recording every request. */
async function serveParts(bodies, { corrupt = new Set(), missing = new Set() } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(request.url.replace(/^\//, ''));
    requests.push({ name, range: request.headers.range ?? null });
    if (missing.has(name) || !bodies.has(name)) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    let body = bodies.get(name);
    if (corrupt.has(name)) {
      body = Buffer.from(body);
      body[body.length - 1] ^= 0xff;
    }
    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    response.statusCode = match ? 206 : 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', body.length - start);
    if (match) response.setHeader('Content-Range', `bytes ${start}-${body.length - 1}/${body.length}`);
    response.end(body.subarray(start));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('assembles an approved model from parts and verifies the whole-file digest', async (t) => {
  const { data, parts, bodies } = plan();
  const source = await serveParts(bodies);
  t.after(source.close);
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, MODEL_NAME);

  const result = await downloadPartedModel({
    parts,
    baseUrls: [source.base],
    destination,
    acceptedSha256: [digest(data)],
    prohibitedHosts: ['huggingface.co'],
  });

  assert.equal(result.parts, 3);
  assert.equal(result.reused, false);
  assert.equal(result.size, data.length);
  assert.deepEqual(await fsp.readFile(destination), data);
  assert.deepEqual(source.requests.map((entry) => entry.name), parts.map((part) => part.name));
});

test('skips parts already assembled and resumes the part in flight', async (t) => {
  const { data, parts, bodies } = plan();
  const source = await serveParts(bodies);
  t.after(source.close);
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, MODEL_NAME);

  // First part complete, second part half written.
  const halfway = parts[0].bytes + Math.floor(parts[1].bytes / 2);
  await fsp.writeFile(`${destination}.part`, data.subarray(0, halfway));

  const result = await downloadPartedModel({
    parts,
    baseUrls: [source.base],
    destination,
    acceptedSha256: [digest(data)],
  });

  assert.deepEqual(await fsp.readFile(destination), data);
  // The completed part is never requested again.
  assert.ok(!source.requests.some((entry) => entry.name === parts[0].name));
  const resumed = source.requests.find((entry) => entry.name === parts[1].name);
  assert.equal(resumed.range, `bytes=${Math.floor(parts[1].bytes / 2)}-`);
  assert.equal(result.size, data.length);
});

test('re-fetches only the part whose SHA-256 does not match', async (t) => {
  const { data, parts, bodies } = plan();
  const source = await serveParts(bodies);
  t.after(source.close);
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, MODEL_NAME);

  // Assemble everything, then corrupt one byte inside the middle part.
  const tampered = Buffer.from(data);
  tampered[parts[0].bytes + 5] ^= 0xff;
  await fsp.writeFile(`${destination}.part`, tampered);

  await downloadPartedModel({
    parts,
    baseUrls: [source.base],
    destination,
    acceptedSha256: [digest(data)],
  });

  assert.deepEqual(await fsp.readFile(destination), data);
  const names = source.requests.map((entry) => entry.name);
  assert.deepEqual(names, [parts[1].name], 'only the damaged part is downloaded again');
});

test('falls over to the next approved base URL for a missing part', async (t) => {
  const { data, parts, bodies } = plan();
  const broken = await serveParts(bodies, { missing: new Set([parts[1].name]) });
  const healthy = await serveParts(bodies);
  t.after(broken.close);
  t.after(healthy.close);
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, MODEL_NAME);

  const result = await downloadPartedModel({
    parts,
    baseUrls: [broken.base, healthy.base],
    destination,
    acceptedSha256: [digest(data)],
  });

  assert.deepEqual(await fsp.readFile(destination), data);
  assert.equal(result.parts, 3);
  assert.ok(broken.requests.some((entry) => entry.name === parts[1].name));
  assert.ok(healthy.requests.some((entry) => entry.name === parts[1].name));
});

test('a persistently corrupt part fails the acquisition instead of installing', async (t) => {
  const { data, parts, bodies } = plan();
  const source = await serveParts(bodies, { corrupt: new Set([parts[2].name]) });
  t.after(source.close);
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, MODEL_NAME);

  await assert.rejects(
    downloadPartedModel({
      parts,
      baseUrls: [source.base],
      destination,
      acceptedSha256: [digest(data)],
    }),
    /Every approved source failed for part .*SHA-256 mismatch/s
  );
  await assert.rejects(fsp.stat(destination), /ENOENT/);
});

test('a wrong whole-file digest quarantines the assembly even when every part matched', async (t) => {
  const { parts, bodies } = plan();
  const source = await serveParts(bodies);
  t.after(source.close);
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, MODEL_NAME);

  await assert.rejects(
    downloadPartedModel({
      parts,
      baseUrls: [source.base],
      destination,
      acceptedSha256: ['0'.repeat(64)],
    }),
    /assembled model failed verification and was quarantined/
  );
  await assert.rejects(fsp.stat(destination), /ENOENT/);
  const remaining = await fsp.readdir(directory);
  assert.ok(remaining.some((name) => name.includes('.invalid-')), 'the rejected assembly is kept for inspection');
});

test('part plans reject unsafe names, duplicates, and bad digests', () => {
  const good = { name: 'a.gguf.part-001', bytes: 10, sha256: 'a'.repeat(64) };
  assert.equal(assertPartPlan([good, { ...good, name: 'a.gguf.part-002' }]).totalBytes, 20);
  assert.throws(() => assertPartPlan([]), /At least one model part/);
  assert.throws(() => assertPartPlan([{ ...good, name: '../escape' }]), /unsafe file name/);
  assert.throws(() => assertPartPlan([good, good]), /Duplicate model part name/);
  assert.throws(() => assertPartPlan([{ ...good, bytes: 0 }]), /invalid byte length/);
  assert.throws(() => assertPartPlan([{ ...good, sha256: 'nope' }]), /invalid SHA-256/);
});

test('the staging splitter and the workstation assembler agree end to end', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));

  // A source model that does not divide evenly, so the last part is short.
  const original = crypto.randomBytes(10 * 1024 + 377);
  Buffer.from('GGUF').copy(original, 0);
  const sourcePath = path.join(directory, MODEL_NAME);
  await fsp.writeFile(sourcePath, original);

  const partsDirectory = path.join(directory, 'parts');
  const split = await splitFile({
    input: sourcePath,
    outputDirectory: partsDirectory,
    fileName: MODEL_NAME,
    partBytes: 4 * 1024,
  });

  assert.equal(split.sha256, digest(original));
  assert.equal(split.totalBytes, original.length);
  assert.deepEqual(
    split.files.map((part) => part.name),
    [`${MODEL_NAME}.part-001`, `${MODEL_NAME}.part-002`, `${MODEL_NAME}.part-003`]
  );
  assert.equal(split.files.at(-1).bytes, 377 + 2 * 1024);

  const bodies = new Map();
  for (const part of split.files) {
    bodies.set(part.name, await fsp.readFile(path.join(partsDirectory, part.name)));
  }
  const source = await serveParts(bodies);
  t.after(source.close);

  const destination = path.join(directory, 'reassembled.gguf');
  const result = await downloadPartedModel({
    parts: split.files,
    baseUrls: [source.base],
    destination,
    acceptedSha256: [split.sha256],
  });

  assert.equal(result.sha256, digest(original));
  assert.deepEqual(await fsp.readFile(destination), original);
});

test('part URLs resolve under the approved base and stay host-checked', () => {
  assert.equal(
    partUrl('https://github.com/o/r/releases/download/tag', 'model.gguf.part-001'),
    'https://github.com/o/r/releases/download/tag/model.gguf.part-001'
  );
  assert.equal(
    partUrl('https://approved.example/models/', 'a b.gguf.part-001'),
    'https://approved.example/models/a%20b.gguf.part-001'
  );
});
