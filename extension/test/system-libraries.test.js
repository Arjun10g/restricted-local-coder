'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  WINDOWS_RUNTIME_LIBRARIES,
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
  await write(directory, 'MSVCP140.DLL', 'VCRuntime140.dll', 'vcruntime140_1.DLL');

  const missing = await missingSystemLibraries(directory, 'win32', { SystemRoot: path.join(directory, 'absent') });
  assert.deepEqual(missing, []);
});

test('every absent library is reported, not just the first', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  await write(directory, 'vcruntime140.dll');

  const missing = await missingSystemLibraries(directory, 'win32', { SystemRoot: path.join(directory, 'absent') });
  assert.deepEqual(missing, ['msvcp140.dll', 'vcruntime140_1.dll']);
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
