'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  runtimeEnvironment,
  sanitizedEnvironment,
  validateExtraArguments,
} = require('../src/runtimePolicy');

test('runtime argument policy rejects network, cloud, UI, and agent overrides', () => {
  for (const args of [
    ['--host=0.0.0.0'],
    ['--port', '9999'],
    ['--tools', 'all'],
    ['--mcp-servers-config=servers.json'],
    ['--webui'],
    ['--agent'],
    ['--hf-repo', 'owner/model'],
    ['--cors-origins=*'],
    ['-ag'],
    ['--rpc', '10.0.0.1:5000'],
    ['--mmproj-url=https://example.com/mmproj.gguf'],
    ['--parallel', '4'],
    ['--cache-ram=8192'],
    ['--ctx-size', '131072'],
    ['--verbose-prompt'],
    ['--log-file', 'prompts.log'],
    ['--metrics'],
    ['--verbosity', '5'],
    ['--log-disable'],
    ['--lora', 'adapter.gguf'],
    ['--unknown-future-flag'],
  ]) {
    assert.throws(() => validateExtraArguments(args), /rejected/);
  }
  assert.deepEqual(
    validateExtraArguments(['--numa', 'distribute', '--prio=1', '--no-warmup']),
    ['--numa', 'distribute', '--prio=1', '--no-warmup']
  );
  assert.throws(() => validateExtraArguments(['--numa']), /requires a value/);
  assert.throws(() => validateExtraArguments(['--warmup=true']), /does not accept/);
});

test('runtime environment removes inherited model-source overrides', () => {
  const result = sanitizedEnvironment('private-key', {
    PATH: '/bin',
    LLAMA_ARG_HOST: '0.0.0.0',
    LLAMA_ARG_TOOLS: 'all',
    HF_TOKEN: 'should-not-pass',
    HUGGINGFACE_TOKEN: 'should-not-pass',
    GGML_BACKEND_PATH: '/untrusted',
    LD_PRELOAD: '/tmp/injected.so',
    LD_LIBRARY_PATH: '/tmp/untrusted-linux-libs',
    DYLD_INSERT_LIBRARIES: '/tmp/injected.dylib',
    DYLD_LIBRARY_PATH: '/tmp/untrusted-macos-libs',
    SAFE_VALUE: 'yes',
  });
  assert.equal(result.PATH, '/bin');
  assert.equal(result.SAFE_VALUE, 'yes');
  assert.equal(result.LLAMA_ARG_HOST, undefined);
  assert.equal(result.LLAMA_ARG_TOOLS, undefined);
  assert.equal(result.HF_TOKEN, undefined);
  assert.equal(result.HUGGINGFACE_TOKEN, undefined);
  assert.equal(result.GGML_BACKEND_PATH, undefined);
  assert.equal(result.LD_PRELOAD, undefined);
  assert.equal(result.LD_LIBRARY_PATH, undefined);
  assert.equal(result.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(result.DYLD_LIBRARY_PATH, undefined);
  assert.equal(result.LLAMA_API_KEY, 'private-key');
});

test('runtime environment uses only the approved adjacent native-library directory', () => {
  const linux = runtimeEnvironment('key', '/opt/local-coder/llama-server', 'linux', {
    PATH: '/usr/bin',
    LD_LIBRARY_PATH: '/tmp/untrusted',
  });
  assert.equal(linux.LD_LIBRARY_PATH, '/opt/local-coder');
  assert.equal(linux.PATH, '/usr/bin');

  const mac = runtimeEnvironment('key', '/Applications/LocalCoder/llama-server', 'darwin', {
    DYLD_LIBRARY_PATH: '/tmp/untrusted',
  });
  assert.equal(mac.DYLD_LIBRARY_PATH, '/Applications/LocalCoder');
});
