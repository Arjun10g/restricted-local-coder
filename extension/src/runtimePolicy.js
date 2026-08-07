'use strict';

const os = require('node:os');
const path = require('node:path');

// Kept explicit so source-policy checks document the surfaces controlled by the extension.
const PROTECTED_ARGUMENTS = new Set([
  '-m', '--model', '-mu', '--model-url', '-a', '--alias',
  '--host', '--port', '--reuse-port', '--api-key', '--api-key-file',
  '--offline', '--online', '--webui', '--no-webui', '--ui', '--no-ui',
  '-ag', '-no-ag', '--agent', '--no-agent', '--tools',
  '--mcp-servers-config', '--mcp-servers-json', '--ui-mcp-proxy', '--webui-mcp-proxy',
  '--path', '--api-prefix', '--cors-origins', '--cors-methods', '--cors-headers',
  '--cors-credentials', '--no-cors-credentials', '--ssl-key-file', '--ssl-cert-file',
  '-hf', '--hf-repo', '--hf-file', '--url', '--mmproj-url', '-mmu', '--rpc',
  '-c', '--ctx-size', '-t', '--threads', '-tb', '--threads-batch',
  '-b', '--batch-size', '-ub', '--ubatch-size', '-np', '--parallel',
  '-ctk', '--cache-type-k', '-ctv', '--cache-type-v', '-lm', '--load-mode',
  '-fa', '--flash-attn', '--jinja', '--no-jinja', '-cram', '--cache-ram',
  '--cache-prompt', '--no-cache-prompt', '--cache-idle-slots', '--no-cache-idle-slots',
  '--slots', '--no-slots', '--slot-save-path', '--log-disable', '--log-file', '--log-prompts',
  '--log-prompts-dir', '--log-colors', '--log-timestamps', '--log-prefix', '--no-log-prefix',
  '-v', '-lv', '--verbose', '--verbose-prompt', '--verbosity', '--log-verbosity',
  '--perf', '--no-perf', '--metrics', '--no-metrics', '--props',
  '--models-dir', '--models-preset', '--models-autoload', '--no-models-autoload',
]);

// Workspace/user settings may only add these CPU scheduling and warm-up controls. An
// allow-list is safer than trying to predict every future llama.cpp network/tool flag.
const SAFE_VALUE_ARGUMENTS = new Set([
  '--cpu-mask',
  '--cpu-range',
  '--cpu-strict',
  '--prio',
  '--poll',
  '--cpu-mask-batch',
  '--cpu-range-batch',
  '--cpu-strict-batch',
  '--prio-batch',
  '--poll-batch',
  '--numa',
]);

const SAFE_SWITCH_ARGUMENTS = new Set([
  '--repack',
  '--no-repack',
  '--op-offload',
  '--no-op-offload',
  '--warmup',
  '--no-warmup',
]);

function argumentName(argument) {
  return String(argument).trim().split('=', 1)[0];
}

function validateToken(argument) {
  if (typeof argument !== 'string' || argument.length === 0 || argument.includes('\0')) {
    throw new Error('Every extra runtime argument must be a non-empty string without NUL bytes');
  }
}

function validateExtraArguments(argumentsValue) {
  if (!Array.isArray(argumentsValue)) {
    throw new Error('localCoder.runtime.extraArguments must be an array');
  }

  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    validateToken(argument);
    const equals = argument.indexOf('=');
    const name = (equals >= 0 ? argument.slice(0, equals) : argument).trim().toLowerCase();
    const inlineValue = equals >= 0 ? argument.slice(equals + 1) : null;

    if (SAFE_SWITCH_ARGUMENTS.has(name)) {
      if (inlineValue !== null) {
        throw new Error(`Boolean runtime argument does not accept an inline value: ${argument}`);
      }
      continue;
    }

    if (SAFE_VALUE_ARGUMENTS.has(name)) {
      if (inlineValue !== null) {
        if (!inlineValue.trim()) throw new Error(`Runtime argument requires a value: ${argument}`);
        continue;
      }
      index += 1;
      if (index >= argumentsValue.length) {
        throw new Error(`Runtime argument requires a value: ${argument}`);
      }
      validateToken(argumentsValue[index]);
      continue;
    }

    throw new Error(`Unsafe or non-allow-listed llama-server argument rejected: ${argument}`);
  }
  return [...argumentsValue];
}

function sanitizedEnvironment(apiKey, sourceEnvironment = process.env) {
  const environment = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (/^(LLAMA_|GGML_|HF_|HUGGINGFACE_)/i.test(key)) continue;
    if (/^(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(key)) continue;
    environment[key] = value;
  }
  environment.LLAMA_API_KEY = apiKey;
  return environment;
}

function runtimeEnvironment(apiKey, runtimePath, platform = process.platform, sourceEnvironment = process.env) {
  const environment = sanitizedEnvironment(apiKey, sourceEnvironment);
  const runtimeDirectory = path.dirname(path.resolve(runtimePath));
  if (platform === 'linux') {
    environment.LD_LIBRARY_PATH = runtimeDirectory;
  } else if (platform === 'darwin') {
    environment.DYLD_LIBRARY_PATH = runtimeDirectory;
  }
  return environment;
}

function automaticThreads() {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(16, Math.floor(available * 0.75)));
}

module.exports = {
  PROTECTED_ARGUMENTS,
  SAFE_SWITCH_ARGUMENTS,
  SAFE_VALUE_ARGUMENTS,
  argumentName,
  automaticThreads,
  runtimeEnvironment,
  sanitizedEnvironment,
  validateExtraArguments,
};
