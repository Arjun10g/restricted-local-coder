#!/usr/bin/env node
'use strict';

/**
 * Confirms every download URL in the manifest actually serves the file the
 * manifest describes.
 *
 * This exists because a profile shipped pointing at a file that had never been
 * uploaded. Every offline check passed: the entry had a well-formed URL, a
 * 64-character digest and a plausible byte count, and `validateManifest` checks
 * shape rather than reachability. The first thing that would have noticed was a
 * user on a locked-down workstation selecting the profile and getting a 404
 * after the extension had already promised them the model.
 *
 * A ranged GET of the first four bytes is enough to settle all three questions
 * at once, for about a kilobyte per model:
 *
 *   - the object exists and is readable without credentials,
 *   - Content-Range reports the total size, which must equal expectedBytes,
 *   - the first bytes are the GGUF magic, so the URL is a model rather than an
 *     error page or an HTML redirect stub served with status 200.
 *
 * The digest still cannot be checked without downloading the whole file, so this
 * does not replace verification at install time -- it catches the failures that
 * make install unreachable in the first place.
 *
 * Kept out of `npm run validate` deliberately: it needs the network, and the
 * offline suite must stay runnable on the target workstation.
 */

const fs = require('node:fs');
const path = require('node:path');

const manifestPath = path.resolve(__dirname, '..', 'extension', 'models', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const GGUF_MAGIC = Buffer.from('GGUF');
const TIMEOUT_MS = 45_000;

function targets() {
  const list = [];
  for (const model of manifest.models) {
    for (const url of model.downloadUrls ?? []) {
      list.push({ label: model.id, url, expectedBytes: model.expectedBytes });
    }
    const draft = model.draftModel;
    for (const url of draft?.downloadUrls ?? []) {
      list.push({ label: `${model.id} (drafter)`, url, expectedBytes: draft.expectedBytes, optional: draft.optional === true });
    }
    // Multi-part profiles list their pieces separately; each one must resolve or
    // the assembled file can never be produced.
    for (const file of model.parts?.files ?? []) {
      list.push({ label: `${model.id} (${file.name})`, url: file.url, expectedBytes: file.expectedBytes });
    }
  }
  return list;
}

async function probe({ url, expectedBytes }) {
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-3' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };

  const range = response.headers.get('content-range') ?? '';
  const served = range.includes('/') ? Number(range.split('/').pop()) : Number(response.headers.get('content-length'));
  const magic = Buffer.from(await response.arrayBuffer());

  if (!magic.subarray(0, 4).equals(GGUF_MAGIC)) {
    // A 200 carrying an HTML error page is the failure this catches: the bytes
    // arrive, the status is fine, and nothing is a model.
    return { ok: false, detail: `not a GGUF file (starts with ${JSON.stringify(magic.subarray(0, 4).toString('latin1'))})` };
  }
  if (Number.isFinite(expectedBytes) && served !== expectedBytes) {
    return { ok: false, detail: `serves ${served} bytes, manifest says ${expectedBytes}` };
  }
  return { ok: true, detail: `${served} bytes` };
}

async function main() {
  const list = targets();
  const failures = [];
  // Sequential on purpose: a handful of URLs, and parallel range requests to the
  // same host read as abuse.
  for (const target of list) {
    let result;
    try {
      result = await probe(target);
    } catch (error) {
      result = { ok: false, detail: `${error.name}: ${error.message}` };
    }
    const mark = result.ok ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${target.label} — ${result.detail}`);
    if (!result.ok) failures.push(`${target.label}: ${result.detail} (${target.url})`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${list.length} model downloads are broken:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error('\nA profile whose file cannot be fetched must not ship: it fails at the');
    console.error('point where the user has already been told the model is available.');
    process.exit(1);
  }
  console.log(`\nAll ${list.length} model download(s) reachable and correctly sized.`);
}

void main();
