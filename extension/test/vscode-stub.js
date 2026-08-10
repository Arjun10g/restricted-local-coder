'use strict';

// The `vscode` module only exists inside the editor host, so requiring any
// extension source that imports it fails under `node --test`. This installs a
// minimal stand-in at resolution time. It is deliberately small: tests that need
// real editor behaviour belong in an integration harness, not here.

const Module = require('node:module');
const path = require('node:path');

const STUB_PATH = path.join(__dirname, 'vscode-stub.js');

const vscode = {
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }),
  },
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_options, task) => task({ report() {} }, { onCancellationRequested() {} }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 15 },
  EventEmitter: class {
    constructor() {
      this.listeners = [];
      this.event = (listener) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
      };
    }

    fire(value) {
      for (const listener of this.listeners) listener(value);
    }

    dispose() {
      this.listeners = [];
    }
  },
};

let installed = false;

function installVscodeStub() {
  if (installed) return vscode;
  installed = true;
  require.cache[STUB_PATH] = { id: STUB_PATH, filename: STUB_PATH, loaded: true, exports: vscode };
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveWithStub(request, ...rest) {
    if (request === 'vscode') return STUB_PATH;
    return originalResolve.call(this, request, ...rest);
  };
  return vscode;
}

module.exports = { installVscodeStub, vscode };
