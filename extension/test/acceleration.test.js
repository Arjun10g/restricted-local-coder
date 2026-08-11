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

// Speculative decoding is opt-in, so tests that exercise it must ask for it.
const DRAFT_ON = { 'runtime.enableDraftModel': true };

const PROFILE = {
  id: 'test-profile',
  shortName: 'Test',
  contextSize: 8192,
  batchSize: 512,
  ubatchSize: 128,
  draftModel: { fileName: 'drafter.gguf', optional: true, specType: 'draft-dflash', blockSize: 16 },
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

  const args = managerWith(DRAFT_ON).accelerationArguments(modelFile, PROFILE);
  assert.ok(args.includes('--model-draft'));
  assert.equal(args[args.indexOf('--model-draft') + 1], path.join(directory, 'drafter.gguf'));
  // 15, not 16: a DFlash drafter spends one of its 16 block slots on the
  // anchor token, so 16 is clamped upstream with a warning.
  assert.equal(args[args.indexOf('--spec-draft-n-max') + 1], '15');
  // Without --spec-type the drafter is loaded and never used: the speculative
  // type defaults to none for a local file, and is only inferred for Hugging
  // Face sidecar downloads. The symptom is silent -- memory spent, no speedup.
  assert.equal(args[args.indexOf('--spec-type') + 1], 'draft-dflash');
  assert.ok(args.includes('--n-gpu-layers-draft'), 'the drafter follows the main model onto the GPU');
  // The upstream spellings removed before the pinned tag must never reappear.
  assert.ok(!args.includes('--draft-max'));
  assert.ok(!args.includes('--draft-min'));
});

test('turning the GPU off also keeps the drafter off the GPU', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-draft-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'drafter.gguf'), 'stub');

  const args = managerWith({ ...DRAFT_ON, 'runtime.gpuLayers': 'off' }).accelerationArguments(
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

test('draftMaxTokens is clamped by the drafter, not by the settings range', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-draft-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'drafter.gguf'), 'stub');
  const modelFile = path.join(directory, 'model.gguf');

  // The ceiling is a property of the drafter -- blockSize - 1 -- not of the
  // setting, so the manifest can describe a drafter with different limits
  // without a code change.
  const high = managerWith({ ...DRAFT_ON, 'runtime.draftMaxTokens': 500 }).accelerationArguments(modelFile, PROFILE);
  assert.equal(high[high.indexOf('--spec-draft-n-max') + 1], '15');
  const low = managerWith({ ...DRAFT_ON, 'runtime.draftMaxTokens': 0 }).accelerationArguments(modelFile, PROFILE);
  assert.equal(low[low.indexOf('--spec-draft-n-max') + 1], '1');

  // A drafter that declares no block size keeps the generic ceiling.
  const generic = managerWith({ ...DRAFT_ON, 'runtime.draftMaxTokens': 500 }).accelerationArguments(modelFile, {
    ...PROFILE,
    draftModel: { fileName: 'drafter.gguf', optional: true },
  });
  assert.equal(generic[generic.indexOf('--spec-draft-n-max') + 1], '64');
  assert.ok(!generic.includes('--spec-type'), 'no spec type is invented for a drafter that declares none');
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
  const cuda = ['cuda'];
  assert.equal(gpuRow(profile, null, 'auto', cuda).status, 'WARN');
  assert.equal(gpuRow(profile, null, 'off', cuda).status, 'PASS');
  assert.equal(gpuRow(profile, [24], 'auto', cuda).status, 'PASS');
  assert.equal(gpuRow(profile, [12], 'auto', cuda).status, 'WARN');
  assert.equal(gpuRow(profile, [4], 'auto', cuda).status, 'WARN');
  // A profile that declares no requirement must not be judged against one.
  assert.equal(gpuRow({}, [8], 'auto', cuda).status, 'PASS');
});

test('a CPU-only build with a GPU present is called out rather than reported as ready', () => {
  const profile = { gpu: { minVramGiB: 8, fullOffloadVramGiB: 20 } };
  // Ample VRAM must not read as PASS when the runtime cannot use it, which is
  // the current state of the win32-x64 CPU build.
  const result = gpuRow(profile, [24], 'auto', []);
  assert.equal(result.status, 'WARN');
  assert.match(result.detail, /CPU-only build/);
  // With no device at all, the CPU-only build is not the interesting fact.
  assert.match(gpuRow(profile, null, 'auto', []).detail, /No NVIDIA device/);
});

test('speculative decoding is opt-in, since a bad pairing fails the whole launch', () => {
  // The drafter published for the default profile is a different architecture
  // (dflash) from the model it drafts for, and llama.cpp refuses the context it
  // needs. Defaulting this on made a working model look broken.
  const declared = require('../package.json').contributes.configuration.properties;
  assert.equal(declared['localCoder.runtime.enableDraftModel'].default, false);
});

test('a launch that offered a drafter is retried without one', async () => {
  const manager = Object.create(RuntimeManager.prototype);
  const logged = [];
  manager.output = { appendLine: (line) => logged.push(line) };
  manager.lastArgumentsUsedDraft = true;
  manager.draftDisabledForSession = false;

  let attempts = 0;
  manager.startInternal = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('failed to create llama_context');
    return 'client';
  };

  assert.equal(await manager.startWithDraftFallback(), 'client');
  assert.equal(attempts, 2, 'must retry exactly once');
  assert.equal(manager.draftDisabledForSession, true);
  assert.ok(logged.some((line) => /Retrying without speculative decoding/.test(line)));
});

test('a failure with no drafter involved is reported, not retried forever', async () => {
  const manager = Object.create(RuntimeManager.prototype);
  manager.output = { appendLine() {} };
  manager.lastArgumentsUsedDraft = false;
  manager.draftDisabledForSession = false;

  let attempts = 0;
  manager.startInternal = async () => {
    attempts += 1;
    throw new Error('the model file is corrupt');
  };

  await assert.rejects(() => manager.startWithDraftFallback(), /corrupt/);
  assert.equal(attempts, 1, 'a genuine failure must surface immediately');
});

test('repacking is off unless a profile asks for it, because it doubles resident memory', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-repack-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modelFile = path.join(directory, 'model.gguf');
  const manager = managerWith({});
  const base = { ...PROFILE, contextSize: 8192, batchSize: 512, ubatchSize: 128 };

  // Measured: repacking keeps a second, private copy of the weights, taking
  // peak resident memory from 17.0 to 31.0 GiB for a 16.5 GiB model.
  const off = manager.buildArguments({ modelFile, profile: base, port: 1, threads: 4 });
  assert.ok(off.includes('--no-repack'));

  const on = manager.buildArguments({ modelFile, profile: { ...base, repack: true }, port: 1, threads: 4 });
  assert.ok(!on.includes('--no-repack'), 'a profile may opt back in when the memory exists');
});

test('the runtime never enables a full-size sliding-window cache', () => {
  // --swa-full would give every layer a full-length KV cache and discard the
  // rolling-window saving that makes the windowed profile affordable.
  const fs2 = require('node:fs');
  const source = fs2.readFileSync(path.join(__dirname, '..', 'src', 'runtimeManager.js'), 'utf8');
  assert.ok(!source.includes('--swa-full'));
  const policy = fs2.readFileSync(path.join(__dirname, '..', 'src', 'runtimePolicy.js'), 'utf8');
  const { validateExtraArguments } = require('../src/runtimePolicy');
  // And a user must not be able to smuggle it in through extraArguments.
  assert.throws(() => validateExtraArguments(['--swa-full']), /not allow-listed|Unsafe/i);
  assert.ok(!policy.includes("'--swa-full'") || policy.includes('PROTECTED'), 'swa-full must never be user-settable');
});
