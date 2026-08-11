'use strict';

/**
 * A test harness small enough to run inside the extension host.
 *
 * node:test's `run()` spawns a child process per test file. Inside Electron that
 * child needs ELECTRON_RUN_AS_NODE and a working `vscode` module resolution, and
 * it has neither -- the run simply hangs with no output, which is how this was
 * first discovered. Tests here must execute in-process, in the extension host,
 * because the whole point is to touch the real editor API.
 *
 * So: collect, then run sequentially. No parallelism, because these tests share
 * one editor and one undo stack.
 */

const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

async function runAll({ timeoutMs = 20_000 } = {}) {
  const results = [];
  for (const testCase of cases) {
    const started = Date.now();
    try {
      await Promise.race([
        testCase.fn(),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref?.()
        ),
      ]);
      results.push({ name: testCase.name, ok: true, ms: Date.now() - started });
    } catch (error) {
      results.push({ name: testCase.name, ok: false, ms: Date.now() - started, error });
    }
  }
  return results;
}

module.exports = { test, runAll, cases };
