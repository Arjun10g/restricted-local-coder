'use strict';

const childProcess = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');
const { getRuntimeKey, missingSystemLibraries, resolveRuntimeBinary } = require('./paths');
const { formatBytes, safeErrorMessage } = require('./util');
const { runtimeEnvironment } = require('./runtimePolicy');

const execFile = promisify(childProcess.execFile);

function row(status, check, detail, remediation = '') {
  return { status, check, detail, remediation };
}

function tableEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

async function freeDiskBytes(directory) {
  if (typeof fsp.statfs !== 'function') return null;
  const stat = await fsp.statfs(directory);
  const blockSize = Number(stat.bsize ?? stat.frsize ?? 0);
  const blocks = Number(stat.bavail ?? stat.bfree ?? 0);
  return blockSize > 0 && blocks >= 0 ? blockSize * blocks : null;
}

async function runtimeVersion(runtimePath) {
  const { stdout, stderr } = await execFile(runtimePath, ['--version'], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: runtimeEnvironment('preflight-version-check', runtimePath),
  });
  return `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(0, 3).join(' · ');
}

async function runPreflight(context, modelRegistry) {
  const rows = [];
  const profile = modelRegistry.getSelectedProfile();
  const config = vscode.workspace.getConfiguration('localCoder');
  const totalRam = os.totalmem();
  const totalRamGiB = totalRam / 1024 ** 3;

  try {
    const key = getRuntimeKey();
    rows.push(row('PASS', 'Platform', `${key} is recognized; the installed VSIX must contain the matching runtime directory.`));
  } catch (error) {
    rows.push(row('FAIL', 'Platform', safeErrorMessage(error), 'Build a compatible llama-server and set localCoder.runtimePath.'));
  }

  if (totalRamGiB >= profile.recommendedRamGiB) {
    rows.push(row('PASS', 'System RAM', `${totalRamGiB.toFixed(1)} GiB detected; profile recommendation is ${profile.recommendedRamGiB} GiB.`));
  } else if (totalRamGiB >= profile.minimumRamGiB) {
    rows.push(row('WARN', 'System RAM', `${totalRamGiB.toFixed(1)} GiB detected; minimum is ${profile.minimumRamGiB} GiB and recommendation is ${profile.recommendedRamGiB} GiB.`, 'Close memory-heavy applications and start with an 8K context.'));
  } else {
    rows.push(row('FAIL', 'System RAM', `${totalRamGiB.toFixed(1)} GiB detected; this profile requires at least ${profile.minimumRamGiB} GiB.`, 'Choose the smaller approved profile or use a machine with more RAM.'));
  }

  let modelDirectory;
  try {
    modelDirectory = await modelRegistry.getModelDirectory();
    const probe = path.join(modelDirectory, `.write-test-${process.pid}-${Date.now()}`);
    await fsp.writeFile(probe, 'ok', { mode: 0o600 });
    await fsp.rm(probe, { force: true });
    rows.push(row('PASS', 'Model directory', `${modelDirectory} is writable.`));
  } catch (error) {
    rows.push(row('FAIL', 'Model directory', safeErrorMessage(error), 'Set localCoder.modelDirectory to a writable user directory.'));
  }

  try {
    const validation = await modelRegistry.validateModel(profile, { full: false });
    if (validation.valid) {
      rows.push(row('PASS', 'Model file', `${validation.filePath} is a validated GGUF (${formatBytes(validation.size)}).${validation.usedCachedHash ? ' Approved SHA-256 was reused from the validation cache.' : ''}`));
    } else if (validation.missing) {
      rows.push(row('WARN', 'Model file', `${profile.fileName} is not installed.`, 'Run “Local Coder: Download or Repair Model” or import the approved file.'));
    } else {
      rows.push(row('FAIL', 'Model file', safeErrorMessage(validation.error), 'Re-download or re-import the exact approved GGUF.'));
    }
  } catch (error) {
    rows.push(row('FAIL', 'Model file', safeErrorMessage(error), 'Review the model directory and manifest profile.'));
  }

  if (modelDirectory) {
    try {
      const free = await freeDiskBytes(modelDirectory);
      if (free === null) {
        rows.push(row('WARN', 'Free disk', 'This VS Code runtime cannot query filesystem capacity.', 'Keep at least the model size plus 3 GiB free.'));
      } else {
        const required = (profile.approximateSizeGiB + 3) * 1024 ** 3;
        rows.push(
          free >= required
            ? row('PASS', 'Free disk', `${formatBytes(free)} available; acquisition target is about ${profile.approximateSizeGiB} GiB.`)
            : row('WARN', 'Free disk', `${formatBytes(free)} available; a clean acquisition may need about ${formatBytes(required)}.`, 'Free disk space or import a model already stored on an approved volume.')
        );
      }
    } catch (error) {
      rows.push(row('WARN', 'Free disk', safeErrorMessage(error), 'Confirm available space manually.'));
    }
  }

  let runtimeBinary = null;
  try {
    runtimeBinary = await resolveRuntimeBinary(context.extensionPath, config.get('runtimePath', ''));
    const version = await runtimeVersion(runtimeBinary);
    rows.push(row('PASS', 'Native runtime', `${runtimeBinary}${version ? ` · ${version}` : ''}`));
  } catch (error) {
    rows.push(row('FAIL', 'Native runtime', safeErrorMessage(error), 'Install the platform-specific VSIX produced by Build platform VSIX.'));
  }

  // A missing MSVC runtime otherwise surfaces only as an opaque loader failure,
  // and an unprivileged user cannot install the redistributable to fix it.
  if (runtimeBinary) {
    try {
      const missing = await missingSystemLibraries(path.dirname(runtimeBinary));
      if (missing.length === 0) {
        rows.push(row('PASS', 'System libraries', 'Every required C/C++ runtime library resolves.'));
      } else {
        rows.push(
          row(
            'FAIL',
            'System libraries',
            `Not found beside the runtime or in System32: ${missing.join(', ')}. Windows does not include the MSVC runtime, so llama-server cannot start.`,
            'Install a VSIX that carries these next to llama-server.exe, or have the Microsoft Visual C++ 2015-2022 Redistributable (x64) deployed.'
          )
        );
      }
    } catch (error) {
      rows.push(row('WARN', 'System libraries', safeErrorMessage(error), 'Confirm the MSVC runtime libraries manually.'));
    }
  }

  if (vscode.workspace.isTrusted) {
    rows.push(row('PASS', 'Workspace trust', 'The current workspace is trusted.'));
  } else {
    rows.push(row('FAIL', 'Workspace trust', 'The current workspace is not trusted.', 'Trust the workspace only after reviewing its contents.'));
  }

  const mirror = config.get('modelMirrorBaseUrl', '').trim();
  const publicAllowed = config.get('network.allowPublicModelDownload', true);
  if (mirror) {
    rows.push(row('PASS', 'Model source', `An internal mirror is configured. Public ModelScope fallback is ${publicAllowed ? 'enabled' : 'disabled'}.`));
  } else if (publicAllowed) {
    rows.push(row('WARN', 'Model source', 'No internal mirror is configured; acquisition will use the approved ModelScope URL.', 'For enterprise deployment, mirror the approved GGUF internally and set localCoder.modelMirrorBaseUrl.'));
  } else {
    rows.push(row('WARN', 'Model source', 'Network model acquisition is disabled.', 'Use “Import Existing GGUF Model” with an approved offline copy.'));
  }

  const promptCacheMiB = config.get('runtime.promptCacheMiB', 512);
  if (promptCacheMiB <= 1024) {
    rows.push(row('PASS', 'Prompt cache', `${promptCacheMiB.toLocaleString()} MiB is bounded for this deployment.`));
  } else {
    rows.push(row('WARN', 'Prompt cache', `${promptCacheMiB.toLocaleString()} MiB reduces RAM headroom on a 32 GB laptop.`, 'Use 512 MiB, or zero to disable prompt caching.'));
  }

  const contextSize = config.get('runtime.contextSize', 0) || profile.contextSize;
  if (contextSize <= 16384) {
    rows.push(row('PASS', 'Context budget', `${contextSize.toLocaleString()} tokens is conservative for a 32 GB laptop.`));
  } else {
    rows.push(row('WARN', 'Context budget', `${contextSize.toLocaleString()} tokens can materially increase KV-cache RAM and prompt latency.`, 'Begin at 8,192 or 16,384 tokens and measure before increasing.'));
  }

  const failures = rows.filter((item) => item.status === 'FAIL').length;
  const warnings = rows.filter((item) => item.status === 'WARN').length;
  const generatedAt = new Date().toISOString();
  const markdown = [
    '# Restricted Local Coder — Preflight',
    '',
    `Generated: ${generatedAt}`,
    '',
    `Selected profile: **${profile.displayName}**`,
    '',
    `Result: **${failures === 0 ? 'READY TO PROCEED' : 'BLOCKED'}** · ${failures} failure(s) · ${warnings} warning(s)`,
    '',
    '| Status | Check | Detail | Remediation |',
    '|---|---|---|---|',
    ...rows.map((item) => `| ${item.status} | ${tableEscape(item.check)} | ${tableEscape(item.detail)} | ${tableEscape(item.remediation)} |`),
    '',
    'A warning is not necessarily a blocker. A failure should be resolved before loading the model.',
  ].join('\n');

  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(document, { preview: true });
  return { rows, failures, warnings, markdown };
}

module.exports = { freeDiskBytes, runPreflight, runtimeVersion };
