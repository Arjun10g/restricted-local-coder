'use strict';

/**
 * Test runner for the real VS Code extension host.
 *
 * VS Code loads this module and calls `run()`; resolving lets the editor exit,
 * throwing marks the run failed. The usual approach is @vscode/test-electron
 * plus mocha, which is several packages and a lockfile for something an
 * already-installed editor can do. This repo ships no npm dependencies and that
 * is worth more than the convenience.
 *
 * These tests exist for one property: an agent edit must land in the editor's
 * undo stack. The offline suite drives applyEdit through an injected stub, which
 * proves the tools request an edit and proves nothing about what VS Code does
 * with it. Undo is the entire safety argument for letting a model write to a
 * user's files, and until now it had never actually been executed.
 */

const { runAll } = require('./harness');

async function run() {
  // Requiring the suite registers its cases with the harness.
  require('./suite/agent-undo.test.js');

  const results = await runAll();
  const failed = results.filter((result) => !result.ok);

  const report = results
    .map((result) =>
      result.ok
        ? `  ok   ${result.name} (${result.ms}ms)`
        : `  FAIL ${result.name}\n       ${result.error?.message ?? result.error}`
    )
    .join('\n');

  console.log(`\nVS Code integration tests (${results.length - failed.length}/${results.length} passed)\n${report}\n`);

  if (failed.length > 0) {
    // The stack of the first failure is the useful one; the summary above
    // already names the rest.
    console.error(failed[0].error?.stack ?? '');
    throw new Error(`${failed.length} integration test(s) failed`);
  }
}

module.exports = { run };
