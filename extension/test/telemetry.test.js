'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { formatTelemetry, summarizeLatency } = require('../src/client');

test('latency reports median and p95, not an average', () => {
  // One long stall among fast tokens. A mean would hide it; the median would
  // report it as fine. Both numbers together describe the actual experience.
  const summary = summarizeLatency([40, 42, 44, 45, 800], 1000, 1200);
  assert.equal(summary.tokens, 6);
  assert.equal(summary.timeToFirstTokenMs, 200);
  assert.ok(summary.medianMsPerToken < 100, 'median should reflect the common case');
  assert.equal(summary.p95MsPerToken, 800, 'p95 must expose the stall');
});

test('a run with no tokens does not invent numbers', () => {
  const summary = summarizeLatency([], 1000, null);
  assert.equal(summary.tokens, 0);
  assert.equal(summary.timeToFirstTokenMs, null);
  assert.equal(summary.medianMsPerToken, null);
  assert.equal(formatTelemetry({ latency: summary }), '');
});

test('prompt and generation are reported separately', () => {
  // They differ by an order of magnitude on this hardware, so a single combined
  // figure would hide which one the user is waiting on.
  const line = formatTelemetry({
    timings: { predicted_per_second: 22.7, prompt_n: 7200, prompt_per_second: 24.2 },
    latency: summarizeLatency([44, 44, 44], 0, 500),
  });
  assert.match(line, /22\.7 tok\/s/);
  assert.match(line, /prompt 7200 @ 24\.2 tok\/s/);
  assert.match(line, /ms\/token/);
  assert.match(line, /to first token/);
});

test('missing server timings degrade to client-side numbers', () => {
  const line = formatTelemetry({ latency: summarizeLatency([50, 60], 0, 100) });
  assert.match(line, /3 tokens/);
  assert.ok(!line.includes('tok/s'), 'throughput needs server timings and must not be guessed');
});
