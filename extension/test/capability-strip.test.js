'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { installVscodeStub } = require('./vscode-stub');

installVscodeStub();
const vscode = require('vscode');
const { ChatViewProvider } = require('../src/chatView');

const rawPanelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');

// Comments are stripped before matching. The doc comment on postCapabilities
// quotes the very strings this guards against, and matching it would be a false
// positive that teaches the next person to weaken the assertion.
const panelSource = rawPanelSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/**
 * The panel makes claims about what the extension may do. Those claims used to
 * be written into the markup -- "cannot run shell commands or edit files",
 * "no cloud fallback" -- and agent mode and web access made both conditionally
 * false. A privacy claim that is wrong in exactly the configurations where it
 * matters is worse than no claim, so these lock the strip to real settings.
 */

/** Drives postCapabilities against a settings map and returns what it posted. */
function capabilitiesFor(settings) {
  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (key in settings ? settings[key] : fallback),
    update: async () => {},
  });
  try {
    const posted = [];
    const provider = Object.create(ChatViewProvider.prototype);
    provider.post = (message) => posted.push(message);
    provider.postCapabilities();
    assert.equal(posted.length, 1);
    return posted[0].capabilities;
  } finally {
    vscode.workspace.getConfiguration = original;
  }
}

test('the shipped defaults claim nothing beyond local inference', () => {
  const capability = capabilitiesFor({});
  assert.equal(capability.canRunCommands, false);
  assert.equal(capability.canEditFiles, false);
  assert.equal(capability.webEnabled, false);
  assert.equal(capability.webHostCount, 0);
});

test('readonly agent mode does not claim commands or edits', () => {
  const capability = capabilitiesFor({ 'agent.mode': 'readonly', 'agent.allowWrite': true });
  assert.equal(capability.canRunCommands, false, 'readonly means readonly whatever allowWrite says');
  assert.equal(capability.canEditFiles, false);
});

test('running commands and editing files are reported separately', () => {
  const commandsOnly = capabilitiesFor({ 'agent.mode': 'allowlist' });
  assert.equal(commandsOnly.canRunCommands, true);
  assert.equal(commandsOnly.canEditFiles, false, 'running tests must not imply rewriting source');

  const both = capabilitiesFor({ 'agent.mode': 'allowlist', 'agent.allowWrite': true });
  assert.equal(both.canEditFiles, true);
});

test('web access is only claimed when it can actually reach something', () => {
  // Enabled with an empty allow-list reaches no host, and permissions.js refuses
  // it. Reporting it as on would overstate the exposure; reporting an unreachable
  // capability as active is the same class of error as hiding a real one.
  assert.equal(capabilitiesFor({ 'web.enabled': true, 'web.allowedHosts': [] }).webEnabled, false);
  assert.equal(capabilitiesFor({ 'web.enabled': false, 'web.allowedHosts': ['a.com'] }).webEnabled, false);

  const on = capabilitiesFor({ 'web.enabled': true, 'web.allowedHosts': ['a.com', 'b.com'] });
  assert.equal(on.webEnabled, true);
  assert.equal(on.webHostCount, 2);
});

test('the panel does not hardcode a privacy claim that settings can falsify', () => {
  assert.ok(
    !/cannot run shell commands or edit files/i.test(panelSource),
    'this claim is false once agent mode is on; the strip must be derived from settings'
  );
  assert.ok(
    !/no cloud fallback/i.test(panelSource),
    'this claim is false once web access is on; the strip must be derived from settings'
  );
});

test('capability text is built as nodes, so a host name cannot forge a separator', () => {
  // The strip is assembled with createElement and textContent. Using innerHTML
  // with a configured host name interpolated would let a crafted allowedHosts
  // entry draw a fake "nothing leaves this machine" segment.
  const strip = panelSource.slice(panelSource.indexOf("case 'capabilities'"));
  const body = strip.slice(0, strip.indexOf("case 'model'"));
  assert.ok(!/innerHTML/.test(body), 'the capability strip must not use innerHTML');
  assert.ok(/textContent/.test(body));
});
