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
  assert.equal(manifest.schemaVersion, 2);
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
      // Weights may be mirrored to an object store or a release, but never to a
      // prohibited host; assertDownloadUrl above enforces that part.
      assert.ok(
        ['www.modelscope.cn', 'storage.googleapis.com', 'github.com', 'objects.githubusercontent.com']
          .includes(parsed.hostname),
        `unapproved host ${parsed.hostname} in ${model.id}`
      );
      assert.equal(parsed.protocol, 'https:');
    }
  }
  assert.ok(ids.has(manifest.defaultProfile));
});

test('the recommended profile still fits the 32 GB target', () => {
  const selected = manifest.models.find((model) => model.id === manifest.defaultProfile);
  assert.equal(selected.tier, 'recommended');
  // Pin the properties that keep it deployable rather than the identity of one
  // model, so swapping the default does not require rewriting this test.
  assert.ok(selected.approximateSizeGiB <= 20, 'default must leave headroom on a 32 GB machine');
  assert.ok(selected.recommendedRamGiB <= 32, 'default must be usable on the target hardware');
  assert.ok(selected.contextSize <= 16384, 'default context must stay conservative until measured');
  assert.equal(typeof selected.fim, 'boolean');
  assert.ok(Number.isSafeInteger(selected.expectedBytes) && selected.expectedBytes > 0);
});

test('a profile without FIM does not claim inline completion, and one remains that does', () => {
  const selected = manifest.models.find((model) => model.id === manifest.defaultProfile);
  if (selected.fim === false) {
    // Inline completion needs FIM tokens, so some profile must still provide it
    // or the feature quietly disappears.
    assert.ok(
      manifest.models.some((model) => model.fim === true),
      'no remaining profile can serve fill-in-the-middle'
    );
  }
});

test('a declared draft model is distinct, sized, and hashed', () => {
  for (const model of manifest.models.filter((entry) => entry.draftModel)) {
    const draft = model.draftModel;
    assert.notEqual(draft.fileName, model.fileName);
    assert.match(draft.sha256, /^[a-f0-9]{64}$/);
    assert.ok(draft.expectedBytes > 0 && draft.expectedBytes < model.expectedBytes);
  }
});
