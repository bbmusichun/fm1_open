#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
// Local-preview build for hosts without PowerShell: the same compile and
// page assembly as `tools/Build-Web.ps1 -LocalPreview`. The PowerShell script
// stays the reference for distribution builds; only WASI SDK on Linux is used
// here (set FM1_WASI_SDK, default /opt/wasi-sdk).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasiSdk = resolve(process.env.FM1_WASI_SDK || '/opt/wasi-sdk');
const sdkRoot = join(wasiSdk, 'share/wasi-sysroot');
const clang = join(wasiSdk, 'bin/clang');

const hash = (data) => createHash('sha256').update(data).digest('hex');
const hashFile = (path) => hash(readFileSync(path));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const sourceRoots = ['app', 'web', 'third_party/synth'];
if (!existsSync(join(root, 'web/engine/Simulator.c'))) {
  throw new Error('Missing browser sources. Download the complete source tree.');
}

// Every C input, minus the device board bring-up that the browser does not use.
const inputs = new Map();
for (const dir of sourceRoots) {
  for (const file of walk(join(root, dir))) {
    const name = relative(root, file).split(sep).join('/');
    if (name.startsWith('app/board/') || !/\.(c|h|inc)$/i.test(name)) continue;
    inputs.set(name, hashFile(file));
  }
}
inputs.set('tools/Build-Web-Preview.mjs', hashFile(fileURLToPath(import.meta.url)));
for (const file of readdirSync(join(root, 'sdk/include'))) {
  if (file.endsWith('.h')) {
    inputs.set(`sdk/include/${file}`, hashFile(join(root, 'sdk/include', file)));
  }
}
const names = [...inputs.keys()].sort();
const sourceHash = hash(names.map((name) => `${name}:${inputs.get(name)}`).join('\n'));

if (!existsSync(clang) || !existsSync(sdkRoot)) {
  throw new Error('Set FM1_WASI_SDK to an extracted WASI SDK 27 directory.');
}

const toolchain = spawnSync(clang, ['--version'], { encoding: 'utf8' });
if (toolchain.status !== 0) throw new Error('WASI SDK clang did not run.');
const toolchainStamp = hash(toolchain.stdout.trim());

const out = join(root, 'build/web');
const wasm = join(out, 'simulator.wasm');
const metadata = join(out, 'simulator.json');
mkdirSync(out, { recursive: true });

let wasmHash = null;
if (existsSync(wasm) && existsSync(metadata)) {
  try {
    const cached = JSON.parse(readFileSync(metadata, 'utf8'));
    if (cached.schema === 2 && cached.toolchain_stamp === toolchainStamp
      && cached.source_sha256 === sourceHash && cached.wasm_sha256 === hashFile(wasm)) {
      wasmHash = cached.wasm_sha256;
      console.log('Browser application is up to date');
    }
  } catch {
    wasmHash = null;
  }
}

if (!wasmHash) {
  const options = [
    `--sysroot=${sdkRoot}`,
    '-std=c11', '-O2', '-fwrapv', '-fno-fast-math', '-ffp-contract=off',
    '-DFM1_HOST_TEST', '-DFM1_OPEN_WEB',
    '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-array-parameter',
    '-mexec-model=reactor',
  ];
  for (const dir of ['web/engine', 'web/synth', 'third_party/synth', 'sdk/include', 'app/synth', 'app']) {
    options.push(`-I${join(root, dir)}`);
  }
  for (const name of names) {
    if (name.endsWith('.c') && !name.startsWith('sdk/')) options.push(join(root, name));
  }
  options.push('-Wl,--strip-all', '-Wl,-z,stack-size=131072',
    '-Wl,--initial-memory=4194304', '-Wl,--max-memory=33554432', '-o', wasm);

  console.log('Compile the browser application');
  const built = spawnSync(clang, options, { stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`Command failed: clang (${built.status})`);

  wasmHash = hashFile(wasm);
  writeFileSync(metadata, JSON.stringify({
    schema: 2, source_sha256: sourceHash, toolchain_stamp: toolchainStamp, wasm_sha256: wasmHash,
  }));
}

const version = /^#define FM1_RELEASE_VERSION "(V(?:0[1-9]|[1-9][0-9]{1,2}))"\s*$/m
  .exec(readFileSync(join(root, 'app/version.h'), 'utf8'));
if (!version) throw new Error('Set FM1_RELEASE_VERSION in app/version.h.');
const releaseVersion = version[1];

// .NET WebUtility.HtmlEncode keeps ASCII and escapes everything else.
function htmlEncode(text) {
  let encoded = '';
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (char === '&') encoded += '&amp;';
    else if (char === '<') encoded += '&lt;';
    else if (char === '>') encoded += '&gt;';
    else if (char === '"') encoded += '&quot;';
    else if (char === "'") encoded += '&#39;';
    else if (code < 128) encoded += char;
    else encoded += `&#${code};`;
  }
  return encoded;
}

const simulation = JSON.stringify({
  schema: 1,
  release_version: releaseVersion,
  sha256: wasmHash,
  source_sha256: sourceHash,
  sample_bank: 'synthesized-demo',
  data: readFileSync(wasm).toString('base64'),
});

const notices = [
  'APP: GPLv3 with the FM1 SDK linking exception; no warranty. SDK and firmware resources have separate redistribution terms in THIRD_PARTY.md. Source: ',
];
for (const file of ['THIRD_PARTY.md', 'LICENSE.md']) {
  notices.push(`\n===== ${file} =====\n${readFileSync(join(root, file), 'utf8')}`);
}

let web = readFileSync(join(root, 'sdk/Update.html.in'), 'utf8');
web = web.replace(/<a\b[^>]*href="\/\*FM1_SOURCE_URL\*\/"[^>]*>(.*?)<\/a>/, '<span>$1 (local preview)</span>');
const replacements = {
  '/*FM1_SOURCE_URL*/': '',
  '/*FM1_PAYLOAD*/': 'const FM1_PACKAGE = null;',
  '/*FM1_SIMULATOR*/': `const FM1_SIMULATOR = ${simulation};`,
  '/*FM1_I18N*/': readFileSync(join(root, 'sdk/I18n.js'), 'utf8'),
  '/*FM1_SCRIPT*/': readFileSync(join(root, 'sdk/WebUpdate.js'), 'utf8'),
  '/*FM1_SIM_SCRIPT*/': readFileSync(join(root, 'sdk/Simulator.js'), 'utf8'),
  '/*FM1_SAMPLE_SCRIPT*/': readFileSync(join(root, 'sdk/Samples.js'), 'utf8'),
  '/*FM1_NOTICES*/': htmlEncode(notices.join('\n')),
};
for (const [key, value] of Object.entries(replacements)) web = web.split(key).join(value);
if (/\/\*FM1_[A-Z_]+\*\//.test(web)) throw new Error('Unexpanded HTML placeholder.');

const output = join(root, 'build/preview/index.html');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, web, 'utf8');
console.log(`Preview: ${relative(root, output)} (${releaseVersion})`);
