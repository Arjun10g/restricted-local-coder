#!/usr/bin/env node
'use strict';

/**
 * Split an approved GGUF into release-asset-sized parts and emit the manifest
 * block the extension needs to reassemble it.
 *
 * Runs on the governed staging machine, never on the target workstation. The
 * source is streamed once, so peak memory stays at one buffer regardless of
 * model size.
 *
 *   node tools/split-model.js \
 *     --input Qwen3-Coder-30B-A3B-Instruct-1M-UD-IQ2_M.gguf \
 *     --output artifacts/model-parts \
 *     --base-url https://github.com/OWNER/REPO/releases/download/model-iq2m-v1/
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// GitHub caps a single release asset at 2 GB. Stay clearly beneath it so the
// decimal/binary reading of that limit never matters.
const DEFAULT_PART_BYTES = 1_900_000_000;
const MAX_PART_BYTES = 2_000_000_000;
const READ_BUFFER = 4 * 1024 * 1024;

/** Name a part exactly as `check-manifest.js` and the extension expect. */
function partName(fileName, index) {
  return `${fileName}.part-${String(index).padStart(3, '0')}`;
}

/**
 * Stream `input` into `<outputDirectory>/<fileName>.part-NNN` chunks.
 * Returns the manifest-shaped part list plus the whole-file digest.
 */
async function splitFile({ input, outputDirectory, fileName, partBytes = DEFAULT_PART_BYTES, onPart }) {
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0 || partBytes > MAX_PART_BYTES) {
    throw new Error(`Part size must be a positive integer no greater than ${MAX_PART_BYTES}`);
  }
  await fsp.mkdir(outputDirectory, { recursive: true });

  const whole = crypto.createHash('sha256');
  const files = [];
  let current = null;
  let index = 0;
  let totalBytes = 0;

  const openPart = () => {
    index += 1;
    const name = partName(fileName, index);
    current = {
      name,
      hash: crypto.createHash('sha256'),
      bytes: 0,
      stream: fs.createWriteStream(path.join(outputDirectory, name), { mode: 0o600 }),
    };
  };

  const write = (chunk) =>
    new Promise((resolve, reject) => {
      current.stream.write(chunk, (error) => (error ? reject(error) : resolve()));
    });

  const closePart = async () => {
    if (!current) return;
    await new Promise((resolve, reject) => {
      current.stream.end((error) => (error ? reject(error) : resolve()));
    });
    const part = { name: current.name, bytes: current.bytes, sha256: current.hash.digest('hex') };
    files.push(part);
    onPart?.(part);
    current = null;
  };

  for await (const chunk of fs.createReadStream(input, { highWaterMark: READ_BUFFER })) {
    whole.update(chunk);
    totalBytes += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      if (!current) openPart();
      const room = partBytes - current.bytes;
      const slice = chunk.subarray(offset, offset + Math.min(room, chunk.length - offset));
      await write(slice);
      current.hash.update(slice);
      current.bytes += slice.length;
      offset += slice.length;
      if (current.bytes >= partBytes) await closePart();
    }
  }
  await closePart();

  const summed = files.reduce((total, part) => total + part.bytes, 0);
  if (summed !== totalBytes) {
    throw new Error(`Part sizes sum to ${summed} but ${totalBytes} bytes were read`);
  }
  return { files, sha256: whole.digest('hex'), totalBytes };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const equals = token.indexOf('=');
    if (equals !== -1) {
      args[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    args[token.slice(2)] = next && !next.startsWith('--') ? argv[(index += 1)] : 'true';
  }
  return args;
}

function usage(message) {
  process.stderr.write(
    `${message}\n\n` +
      'Usage: node tools/split-model.js --input <model.gguf> --output <directory>\n' +
      '                                 [--profile <id>] [--base-url <url>]\n' +
      `                                 [--part-size <bytes, default ${DEFAULT_PART_BYTES}>]\n`
  );
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) usage('--input is required');
  if (!args.output) usage('--output is required');

  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'extension', 'models', 'manifest.json'), 'utf8'));
  const profileId = args.profile ?? manifest.defaultProfile;
  const profile = manifest.models.find((model) => model.id === profileId);
  if (!profile) usage(`Unknown profile '${profileId}'`);

  const input = path.resolve(args.input);
  const outputDirectory = path.resolve(args.output);
  const stat = await fsp.stat(input);
  if (!stat.isFile()) usage(`${input} is not a regular file`);
  if (path.basename(input) !== profile.fileName) {
    process.stderr.write(
      `Warning: input is named ${path.basename(input)} but profile ${profile.id} expects ${profile.fileName}.\n` +
        'Part names follow the manifest file name so the extension can find them.\n'
    );
  }

  process.stdout.write(`Splitting ${path.basename(input)} (${stat.size.toLocaleString()} bytes)\n`);
  const { files, sha256, totalBytes } = await splitFile({
    input,
    outputDirectory,
    fileName: profile.fileName,
    partBytes: Number(args['part-size'] ?? DEFAULT_PART_BYTES),
    onPart: (part) => process.stdout.write(`  ${part.name}  ${part.bytes.toLocaleString()} bytes\n`),
  });

  const approved = profile.acceptedSha256.map((value) => String(value).toLowerCase());
  if (!approved.includes(sha256)) {
    throw new Error(
      `Refusing to publish: source SHA-256 ${sha256} is not approved for profile ${profile.id}.\n` +
        `Approved: ${approved.join(', ')}`
    );
  }

  const base = args['base-url'];
  const block = {
    baseUrls: base ? [base.endsWith('/') ? base : `${base}/`] : [],
    files,
  };
  const blockPath = path.join(outputDirectory, 'parts.json');
  await fsp.writeFile(blockPath, `${JSON.stringify(block, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\nWhole-file SHA-256 verified against profile ${profile.id}.\n` +
      `${files.length} parts (${totalBytes.toLocaleString()} bytes) written to ${outputDirectory}\n` +
      `Manifest block: ${blockPath}\n\n` +
      'Next: upload the .part-* files as release assets, then paste parts.json into\n' +
      `the "parts" field of profile ${profile.id} in extension/models/manifest.json.\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { DEFAULT_PART_BYTES, MAX_PART_BYTES, partName, splitFile };
