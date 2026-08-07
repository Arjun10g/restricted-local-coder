#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extension');
const packageJson = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
assert.equal(packageJson.main, './src/extension.js');
assert.ok(!packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0, 'Runtime npm dependencies are not allowed');
assert.ok(!packageJson.extensionDependencies, 'Cloud/helper extension dependencies are not allowed');
assert.equal(packageJson.capabilities?.untrustedWorkspaces?.supported, false);
const settings = packageJson.contributes?.configuration?.properties ?? {};
assert.ok(settings['localCoder.runtime.promptCacheMiB'], 'Bounded prompt-cache setting is missing');
assert.ok(!settings['localCoder.download.verifySha256'], 'Model hash verification must not be user-disableable');
assert.ok(!JSON.stringify(packageJson).includes('REPLACE_ME'), 'Placeholder repository metadata must be removed');

const runtime = fs.readFileSync(path.join(extensionRoot, 'src', 'runtimeManager.js'), 'utf8');
for (const required of [
  "'127.0.0.1'",
  "'--no-webui'",
  "'--no-agent'",
  "'--offline'",
  "'--cors-origins'",
  "'q8_0'",
  "'--parallel'",
  "'--cache-ram'",
  "'--no-slots'",
  "'--no-cors-credentials'",
  "'--no-cache-idle-slots'",
]) {
  assert.ok(runtime.includes(required), `Runtime hardening is missing ${required}`);
}
assert.ok(!runtime.includes("'0.0.0.0'"), 'Runtime source must not bind to all interfaces');

const policy = fs.readFileSync(path.join(extensionRoot, 'src', 'runtimePolicy.js'), 'utf8');
assert.ok(policy.includes('SAFE_VALUE_ARGUMENTS'), 'Runtime extras must use a strict allow-list');
for (const protectedFlag of ['--tools', '--mcp-servers-config', '--agent', '--webui', '--hf-repo', '--cors-origins', '--rpc', '--parallel', '--cache-ram', '--log-file', '--verbose-prompt']) {
  assert.ok(policy.includes(`'${protectedFlag}'`), `Runtime policy does not protect ${protectedFlag}`);
}

const downloader = fs.readFileSync(path.join(extensionRoot, 'src', 'downloader.js'), 'utf8');
for (const required of ['Range', 'Content-Range', 'GGUF_MAGIC', 'sha256', 'require HTTPS']) {
  assert.ok(downloader.includes(required), `Downloader is missing ${required}`);
}

const contextRules = fs.readFileSync(path.join(extensionRoot, 'src', 'contextRules.js'), 'utf8');
for (const sensitive of ["'.env'", "'.vscode'", "'.ssh'", "'.aws'", "'.pem'", "'.key'", "'.gguf'", "'credentials.json'"]) {
  assert.ok(contextRules.includes(sensitive), `Context exclusions are missing ${sensitive}`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

const executableSource = [
  ...walk(path.join(extensionRoot, 'src')),
  ...walk(path.join(extensionRoot, 'test')),
].filter((file) => file.endsWith('.js'));
for (const file of executableSource) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/https?:\/\/["'`]?(?:api\.)?(?:openai|anthropic|googleapis)\./i.test(text), `Cloud inference endpoint in ${path.relative(root, file)}`);
  assert.ok(!/child_process\.(?:exec|execSync)\s*\(/.test(text), `Shell execution helper in ${path.relative(root, file)}`);
}


const lock = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'llama.cpp.lock.json'), 'utf8'));
assert.equal(lock.repository, 'https://github.com/ggml-org/llama.cpp.git');
assert.match(lock.commit, /^[a-f0-9]{40}$/, 'llama.cpp lock must use a full immutable commit');

const benchmarkTasks = JSON.parse(fs.readFileSync(path.join(root, 'bench', 'coding-smoke.json'), 'utf8'));
assert.ok(Array.isArray(benchmarkTasks) && benchmarkTasks.length >= 5, 'Coding benchmark needs at least five tasks');
for (const task of benchmarkTasks) {
  assert.ok(task.id && task.prompt, 'Benchmark task id/prompt is missing');
  assert.ok(Array.isArray(task.mustMatch) && task.mustMatch.length > 0, `Benchmark ${task.id} has no positive checks`);
  assert.ok(Array.isArray(task.mustNotMatch), `Benchmark ${task.id} has no negative-check array`);
  for (const pattern of [...task.mustMatch, ...task.mustNotMatch]) new RegExp(pattern, 'is');
}

const workflowPins = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
};
const workflowFiles = walk(path.join(root, '.github', 'workflows')).filter((file) => /\.ya?ml$/i.test(file));
const allWorkflowText = workflowFiles.map((workflow) => fs.readFileSync(workflow, 'utf8')).join('\n');
for (const [action, commit] of Object.entries(workflowPins)) {
  assert.ok(
    allWorkflowText.includes(`${action}@${commit}`),
    `${action} must appear at its approved full commit in the checked-in workflows`
  );
}
assert.ok(allWorkflowText.includes('package-manager-cache: false'), 'npm package-manager caching must remain disabled');
for (const workflow of workflowFiles) {
  const text = fs.readFileSync(workflow, 'utf8');
  for (const match of text.matchAll(/uses:\s+(actions\/(?:checkout|setup-node|upload-artifact|download-artifact))@([^\s#]+)/g)) {
    const expected = workflowPins[match[1]];
    assert.equal(match[2], expected, `${match[1]} must be pinned to the approved full commit in ${path.relative(root, workflow)}`);
  }
  assert.ok(!/uses:\s+actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v\d+/i.test(text), `Mutable action tag in ${path.relative(root, workflow)}`);
}

const requiredFiles = [
  'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
  'extension/src/extension.js', 'extension/src/chatView.js',
  'extension/src/runtimeManager.js', 'extension/src/downloader.js',
  'vendor/llama.cpp.lock.json',
  'bench/coding-smoke.json', 'scripts/Invoke-ModelBenchmark.ps1',
  'tools/split-model.js', 'scripts/Publish-ModelParts.ps1',
];
for (const relative of requiredFiles) {
  assert.ok(fs.existsSync(path.join(root, relative)), `Missing required file ${relative}`);
}

console.log(`Source policy OK: ${executableSource.length} JavaScript files checked`);
