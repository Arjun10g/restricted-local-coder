#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertDownloadUrl } = require('../extension/src/downloader');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'models', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.schemaVersion, 1, 'Unsupported manifest schema');
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
  assert.equal(model.fim, true, `${model.id} is not marked FIM-capable`);
  assert.ok(Array.isArray(model.acceptedSha256) && model.acceptedSha256.length > 0);
  for (const hash of model.acceptedSha256) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(model.downloadUrls) && model.downloadUrls.length > 0);
  for (const rawUrl of model.downloadUrls) {
    const url = assertDownloadUrl(rawUrl, manifest.prohibitedHosts);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'www.modelscope.cn', `Unexpected public host in ${model.id}`);
    assert.ok(url.pathname.endsWith(`/${model.fileName}`));
  }
}
assert.ok(ids.has(manifest.defaultProfile), 'Default profile does not exist');
const recommended = manifest.models.find((model) => model.id === manifest.defaultProfile);
assert.equal(recommended.tier, 'recommended');
assert.equal(recommended.nominalBitClass, '2-bit');

console.log(`Manifest OK: ${manifest.models.length} approved profiles; default=${manifest.defaultProfile}`);
