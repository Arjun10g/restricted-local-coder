'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  WINDOWS_RUNTIME_LIBRARIES,
  acceleratedRuntimeKeys,
  missingSystemLibraries,
  requiredSystemLibraries,
} = require('../src/paths');

async function temporaryDirectory() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'local-coder-libs-'));
}

async function write(directory, ...names) {
  await fsp.mkdir(directory, { recursive: true });
  for (const name of names) {
    await fsp.writeFile(path.join(directory, name), 'stub');
  }
}

test('an accelerated runtime is offered only where one exists', () => {
  // Windows gets a CUDA build; nothing else does, and the base key must never
  // list itself or the CPU fallback would be skipped.
  assert.deepEqual(acceleratedRuntimeKeys('win32-x64'), ['win32-x64-cuda']);
  assert.deepEqual(acceleratedRuntimeKeys('darwin-arm64'), []);
  assert.deepEqual(acceleratedRuntimeKeys('linux-x64'), []);
  assert.ok(!acceleratedRuntimeKeys('win32-x64').includes('win32-x64'));
});

test('only Windows declares required C/C++ runtime libraries', () => {
  assert.deepEqual(requiredSystemLibraries('win32'), WINDOWS_RUNTIME_LIBRARIES);
  assert.deepEqual(requiredSystemLibraries('linux'), []);
  assert.deepEqual(requiredSystemLibraries('darwin'), []);
  // The list is copied, so a caller cannot mutate the module's own array.
  requiredSystemLibraries('win32').push('injected.dll');
  assert.deepEqual(requiredSystemLibraries('win32'), WINDOWS_RUNTIME_LIBRARIES);
});

test('libraries shipped beside the runtime satisfy the requirement', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  await write(directory, ...WINDOWS_RUNTIME_LIBRARIES);

  const missing = await missingSystemLibraries(directory, 'win32', { SystemRoot: path.join(directory, 'absent') });
  assert.deepEqual(missing, []);
});

test('an installed redistributable in System32 also satisfies it', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  await write(runtime, 'llama-server.exe');
  await write(path.join(root, 'windows', 'System32'), ...WINDOWS_RUNTIME_LIBRARIES);

  const missing = await missingSystemLibraries(runtime, 'win32', { SystemRoot: path.join(root, 'windows') });
  assert.deepEqual(missing, []);
});

test('matching ignores case, as the Windows filesystem does', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  // Derived from the exported list rather than hardcoded, so adding a required
  // library cannot leave this test asserting a stale expectation.
  await write(directory, ...WINDOWS_RUNTIME_LIBRARIES.map((name, index) => (index % 2 ? name.toUpperCase() : name)));

  const missing = await missingSystemLibraries(directory, 'win32', { SystemRoot: path.join(directory, 'absent') });
  assert.deepEqual(missing, []);
});

test('every absent library is reported, not just the first', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const [provided, ...absent] = WINDOWS_RUNTIME_LIBRARIES;
  await write(directory, provided);

  const missing = await missingSystemLibraries(directory, 'win32', { SystemRoot: path.join(directory, 'absent') });
  assert.deepEqual(missing, absent);
});

test('the OpenMP runtime is required, because every ggml-cpu backend imports it', () => {
  // It ships inside the upstream archive, not with Windows. A packaging filter
  // once dropped it, and llama-server then failed to load with nothing to go on
  // beyond a failed --version.
  assert.ok(WINDOWS_RUNTIME_LIBRARIES.includes('libomp140.x86_64.dll'));
});

test('a missing runtime directory is reported rather than throwing', async () => {
  const missing = await missingSystemLibraries('/nonexistent-runtime-directory', 'win32', {
    SystemRoot: '/nonexistent-windows',
  });
  assert.deepEqual(missing, WINDOWS_RUNTIME_LIBRARIES);
});

test('non-Windows platforms need no check even with an empty directory', async () => {
  assert.deepEqual(await missingSystemLibraries('/nonexistent', 'linux', {}), []);
  assert.deepEqual(await missingSystemLibraries('/nonexistent', 'darwin', {}), []);
});
