'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installVscodeStub } = require('./vscode-stub');

installVscodeStub();

const { RuntimeManager } = require('../src/runtimeManager');
const { buildFimPrompt, DEFAULT_FIM_TEMPLATE } = require('../src/client');
const { gpuRow } = require('../src/preflight');

function managerWith(settings) {
  // Only config() and output are reachable from the argument builders, so the
  // rest of the constructor is deliberately not exercised here.
  const manager = Object.create(RuntimeManager.prototype);
  manager.output = { appendLine() {} };
  manager.config = () => ({
    get: (key, fallback) => (key in settings ? settings[key] : fallback),
  });
  return manager;
}

const PROFILE = {
  id: 'test-profile',
  shortName: 'Test',
  contextSize: 8192,
  batchSize: 512,
  ubatchSize: 128,
  draftModel: { fileName: 'drafter.gguf', optional: true },
};

test('gpuLayers accepts auto, off, an explicit count, and refuses to misread a typo', () => {
  const manager = managerWith({});
  assert.equal(manager.resolveGpuLayers('auto'), '-1');
  assert.equal(manager.resolveGpuLayers('off'), null);
  assert.equal(manager.resolveGpuLayers(24), '24');
  assert.equal(manager.resolveGpuLayers('24'), '24');
  assert.equal(manager.resolveGpuLayers(1000), '999', 'must clamp to the declared maximum');
  // A typo must not read as "zero layers", which would look like a lost GPU.
  assert.equal(manager.resolveGpuLayers('atuo'), '-1');
});

test('a missing drafter leaves speculative decoding off without failing the launch', () => {
  const manager = managerWith({});
  const modelFile = path.join(os.tmpdir(), 'local-coder-test', 'model.gguf');
  const args = manager.accelerationArguments(modelFile, PROFILE);
  assert.deepEqual(args, ['--n-gpu-layers', '-1']);
  assert.ok(!args.includes('--model-draft'));
});

test('an installed drafter is passed with the flag names the pinned tag accepts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-draft-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modelFile = path.join(directory, 'model.gguf');
  fs.writeFileSync(path.join(directory, 'drafter.gguf'), 'stub');

  const args = managerWith({}).accelerationArguments(modelFile, PROFILE);
  assert.ok(args.includes('--model-draft'));
  assert.equal(args[args.indexOf('--model-draft') + 1], path.join(directory, 'drafter.gguf'));
  assert.equal(args[args.indexOf('--spec-draft-n-max') + 1], '16');
  assert.ok(args.includes('--n-gpu-layers-draft'), 'the drafter follows the main model onto the GPU');
  // The upstream spellings removed before the pinned tag must never reappear.
  assert.ok(!args.includes('--draft-max'));
  assert.ok(!args.includes('--draft-min'));
});

test('turning the GPU off also keeps the drafter off the GPU', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-draft-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'drafter.gguf'), 'stub');

  const args = managerWith({ 'runtime.gpuLayers': 'off' }).accelerationArguments(
    path.join(directory, 'model.gguf'),
    PROFILE
  );
  assert.ok(!args.includes('--n-gpu-layers'));
  assert.ok(!args.includes('--n-gpu-layers-draft'));
  assert.ok(args.includes('--model-draft'), 'CPU-only speculative decoding is still valid');
});

test('disabling the draft setting suppresses speculative decoding even when installed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-draft-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'drafter.gguf'), 'stub');

  const args = managerWith({ 'runtime.enableDraftModel': false }).accelerationArguments(
    path.join(directory, 'model.gguf'),
    PROFILE
  );
  assert.ok(!args.includes('--model-draft'));
});

test('draftMaxTokens is clamped into the range the setting declares', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-draft-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'drafter.gguf'), 'stub');
  const modelFile = path.join(directory, 'model.gguf');

  const high = managerWith({ 'runtime.draftMaxTokens': 500 }).accelerationArguments(modelFile, PROFILE);
  assert.equal(high[high.indexOf('--spec-draft-n-max') + 1], '64');
  const low = managerWith({ 'runtime.draftMaxTokens': 0 }).accelerationArguments(modelFile, PROFILE);
  assert.equal(low[low.indexOf('--spec-draft-n-max') + 1], '1');
});

test('a profile without a draft model never receives drafting flags', () => {
  const args = managerWith({}).accelerationArguments('/models/model.gguf', {
    ...PROFILE,
    draftModel: undefined,
  });
  assert.deepEqual(args, ['--n-gpu-layers', '-1']);
});

test('the FIM prompt defaults to the Qwen spelling and honours a profile override', () => {
  const fallback = buildFimPrompt({ fim: true }, 'before', 'after');
  assert.equal(fallback.prompt, '<|fim_prefix|>before<|fim_suffix|>after<|fim_middle|>');
  assert.deepEqual(fallback.stop, DEFAULT_FIM_TEMPLATE.stop);

  const overridden = buildFimPrompt(
    { fim: true, fimTemplate: { prefix: '<PRE>', suffix: '<SUF>', middle: '<MID>', stop: ['<EOT>'] } },
    'before',
    'after'
  );
  assert.equal(overridden.prompt, '<PRE>before<SUF>after<MID>');
  assert.deepEqual(overridden.stop, ['<EOT>']);
});

test('the GPU preflight row reports absence as guidance rather than failure', () => {
  const profile = { gpu: { minVramGiB: 8, fullOffloadVramGiB: 20 } };
  assert.equal(gpuRow(profile, null, 'auto').status, 'WARN');
  assert.equal(gpuRow(profile, null, 'off').status, 'PASS');
  assert.equal(gpuRow(profile, [24], 'auto').status, 'PASS');
  assert.equal(gpuRow(profile, [12], 'auto').status, 'WARN');
  assert.equal(gpuRow(profile, [4], 'auto').status, 'WARN');
  // A profile that declares no requirement must not be judged against one.
  assert.equal(gpuRow({}, [8], 'auto').status, 'PASS');
});
