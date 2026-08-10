#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertDownloadUrl } = require('../extension/src/downloader');

// A single GitHub release asset may not exceed 2 GB.
const RELEASE_ASSET_LIMIT = 2_000_000_000;

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'models', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.schemaVersion, 2, 'Unsupported manifest schema');

// Weights may be served from any of these; Hugging Face stays prohibited and is
// checked separately through prohibitedHosts.
const APPROVED_MODEL_HOSTS = new Set([
  'www.modelscope.cn',
  'storage.googleapis.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
assert.match(manifest.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(Array.isArray(manifest.prohibitedHosts) && manifest.prohibitedHosts.length > 0);
assert.ok(Array.isArray(manifest.models) && manifest.models.length > 0);

const ids = new Set();
const names = new Set();
for (const model of manifest.models) {
  assert.ok(model.id && !ids.has(model.id), `Duplicate or empty model id: ${model.id}`);
  ids.add(model.id);
  assert.match(model.fileName, /^[^/\\]+\.gguf$/i, `Unsafe fileName for ${model.id}`);
  assert.ok(!names.has(model.fileName), `Duplicate model fileName: ${model.fileName}`);
  names.add(model.fileName);
  assert.equal(model.format, 'GGUF');
  assert.equal(model.license, 'Apache-2.0');
  assert.ok(model.approximateSizeGiB > 1 && model.approximateSizeGiB < 40);
  assert.ok(model.minimumRamGiB >= 16 && model.recommendedRamGiB >= model.minimumRamGiB);
  assert.ok(model.contextSize >= 2048 && model.contextSize <= 32768, `${model.id} has an unsafe default context`);
  assert.ok(model.batchSize >= model.ubatchSize);
  assert.ok(model.maxOutputTokens > 0);
  // Fill-in-the-middle is no longer universal: agentic chat models ship without
  // FIM tokens, so inline completion is driven per profile rather than assumed.
  assert.equal(typeof model.fim, 'boolean', `${model.id} must state whether it supports FIM`);

  if (model.draftModel) {
    const draft = model.draftModel;
    assert.match(draft.fileName, /^[^/\\]+\.gguf$/i, `${model.id} draft model has an unsafe fileName`);
    assert.match(draft.sha256, /^[a-f0-9]{64}$/, `${model.id} draft model needs a SHA-256`);
    assert.ok(
      Number.isSafeInteger(draft.expectedBytes) && draft.expectedBytes > 0,
      `${model.id} draft model needs a byte length`
    );
    assert.notEqual(draft.fileName, model.fileName, `${model.id} draft model must differ from the model`);
    assert.ok(
      draft.expectedBytes < model.expectedBytes,
      `${model.id} draft model is not smaller than the model it drafts for`
    );
    // The drafter is fetched over the same path as the weights, so its sources
    // are held to the same host policy.
    assert.ok(
      Array.isArray(draft.downloadUrls) && draft.downloadUrls.length > 0,
      `${model.id} draft model has no download URL, so it can never be acquired`
    );
    for (const rawUrl of draft.downloadUrls) {
      const url = assertDownloadUrl(rawUrl, manifest.prohibitedHosts);
      assert.equal(url.protocol, 'https:');
      assert.ok(APPROVED_MODEL_HOSTS.has(url.hostname), `Unapproved draft host ${url.hostname} in ${model.id}`);
      assert.ok(
        url.pathname.endsWith(`/${draft.fileName}`),
        `${model.id} draft URL does not end in its declared file name`
      );
    }
  }
  assert.ok(Array.isArray(model.acceptedSha256) && model.acceptedSha256.length > 0);
  for (const hash of model.acceptedSha256) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(model.downloadUrls) && model.downloadUrls.length > 0);
  for (const rawUrl of model.downloadUrls) {
    const url = assertDownloadUrl(rawUrl, manifest.prohibitedHosts);
    assert.equal(url.protocol, 'https:');
    assert.ok(APPROVED_MODEL_HOSTS.has(url.hostname), `Unapproved model host ${url.hostname} in ${model.id}`);
    assert.ok(url.pathname.endsWith(`/${model.fileName}`));
  }

  if (model.parts) {
    assert.ok(
      Array.isArray(model.parts.baseUrls) && model.parts.baseUrls.length > 0,
      `${model.id} declares parts without a base URL`
    );
    assert.ok(Array.isArray(model.parts.files) && model.parts.files.length > 0, `${model.id} has an empty part list`);

    const partDigests = new Set();
    let summed = 0;
    for (const [index, part] of model.parts.files.entries()) {
      const expectedName = `${model.fileName}.part-${String(index + 1).padStart(3, '0')}`;
      assert.equal(part.name, expectedName, `${model.id} part ${index + 1} must be named ${expectedName}`);
      assert.ok(Number.isSafeInteger(part.bytes) && part.bytes > 0, `${part.name} has an invalid byte length`);
      assert.ok(
        part.bytes <= RELEASE_ASSET_LIMIT,
        `${part.name} is ${part.bytes} bytes, above the ${RELEASE_ASSET_LIMIT}-byte release-asset limit`
      );
      assert.match(part.sha256, /^[a-f0-9]{64}$/, `${part.name} has an invalid SHA-256`);
      assert.ok(!partDigests.has(part.sha256), `${model.id} repeats a part digest at ${part.name}`);
      partDigests.add(part.sha256);
      summed += part.bytes;
    }

    for (const rawBase of model.parts.baseUrls) {
      const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
      const url = assertDownloadUrl(new URL(encodeURIComponent(model.parts.files[0].name), base).toString(), manifest.prohibitedHosts);
      assert.equal(url.protocol, 'https:', `${model.id} part base URL must be HTTPS`);
    }

    if (Number.isSafeInteger(model.expectedBytes)) {
      assert.equal(summed, model.expectedBytes, `${model.id} part sizes do not sum to expectedBytes`);
    }
    const declared = model.approximateSizeGiB * 1024 ** 3;
    assert.ok(
      Math.abs(summed - declared) / declared < 0.02,
      `${model.id} part sizes sum to ${summed} bytes, more than 2% from the declared ${model.approximateSizeGiB} GiB`
    );
  }
}
assert.ok(ids.has(manifest.defaultProfile), 'Default profile does not exist');
const recommended = manifest.models.find((model) => model.id === manifest.defaultProfile);
assert.equal(recommended.tier, 'recommended');
// The default no longer has to be an aggressive 2-bit squeeze; what matters is
// that it still fits the 32 GB target with room for the KV cache, the editor,
// and the operating system.
assert.ok(
  ['2-bit', '4-bit'].includes(recommended.nominalBitClass),
  `Default profile bit class ${recommended.nominalBitClass} is outside the approved range`
);
assert.ok(
  recommended.approximateSizeGiB <= 20,
  `Default profile is ${recommended.approximateSizeGiB} GiB, above the 20 GiB ceiling for a 32 GB machine`
);

console.log(`Manifest OK: ${manifest.models.length} approved profiles; default=${manifest.defaultProfile}`);
