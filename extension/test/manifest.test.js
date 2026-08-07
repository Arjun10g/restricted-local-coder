'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assertDownloadUrl } = require('../src/downloader');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'models', 'manifest.json'), 'utf8')
);

test('model manifest is internally consistent and has no Hugging Face download', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.models) && manifest.models.length >= 3);
  const ids = new Set();
  for (const model of manifest.models) {
    assert.ok(model.id);
    assert.equal(ids.has(model.id), false, `duplicate id ${model.id}`);
    ids.add(model.id);
    assert.match(model.fileName, /^[^/\\]+\.gguf$/i);
    assert.ok(model.approximateSizeGiB > 0);
    assert.ok(model.minimumRamGiB > 0);
    assert.ok(model.recommendedRamGiB >= model.minimumRamGiB);
    assert.ok(Array.isArray(model.acceptedSha256) && model.acceptedSha256.length > 0);
    for (const hash of model.acceptedSha256) assert.match(hash, /^[a-f0-9]{64}$/);
    for (const url of model.downloadUrls) {
      const parsed = assertDownloadUrl(url, manifest.prohibitedHosts);
      assert.equal(parsed.hostname, 'www.modelscope.cn');
    }
  }
  assert.ok(ids.has(manifest.defaultProfile));
});

test('recommended profile is the 2-bit 30B-A3B coding profile', () => {
  const selected = manifest.models.find((model) => model.id === manifest.defaultProfile);
  assert.equal(selected.tier, 'recommended');
  assert.equal(selected.quantization, 'UD-IQ2_M');
  assert.equal(selected.fim, true);
  assert.ok(selected.approximateSizeGiB < 12);
  assert.ok(selected.contextSize <= 16384);
});
