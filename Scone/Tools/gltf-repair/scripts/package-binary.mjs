import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const resolveFromToolRoot = createRequire(path.join(toolRoot, 'package.json'));
const pkgCliEntry = resolveFromToolRoot.resolve('pkg/lib-es5/bin.js');
const distEntry = path.join(toolRoot, 'dist', 'pkg-entry.cjs');
const outDir = path.join(toolRoot, 'bin');

if (!fs.existsSync(distEntry)) {
  throw new Error('Missing dist/pkg-entry.cjs. Run "npm run build:pkg-entry" first.');
}

const distSource = fs.readFileSync(distEntry, 'utf8');
const patchedSource = distSource
  .replaceAll('import("node:fs")', 'Promise.resolve(require("node:fs"))')
  .replaceAll('import("node:path")', 'Promise.resolve(require("node:path"))')
  // pkg runtime does not provide import.meta.url in this bundled CJS context.
  .replace(/\(0,\s*import_node_module\d*\.createRequire\)\(import_meta\d*\.url\)/g, 'require');

if (patchedSource !== distSource) {
  fs.writeFileSync(distEntry, patchedSource, 'utf8');
}

if (fs.existsSync(outDir)) {
  for (const entry of fs.readdirSync(outDir)) {
    fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
}
fs.mkdirSync(outDir, { recursive: true });

const allTargets = [
  { target: 'node18-linux-x64', output: 'gltf-repair-linux-x64' },
  { target: 'node18-linux-arm64', output: 'gltf-repair-linux-arm64' },
  { target: 'node18-macos-x64', output: 'gltf-repair-macos-x64' },
  { target: 'node18-macos-arm64', output: 'gltf-repair-macos-arm64' },
  { target: 'node18-win-x64', output: 'gltf-repair-win-x64.exe' },
  { target: 'node18-win-arm64', output: 'gltf-repair-win-arm64.exe' },
];

const targetArg = process.argv.find((arg) => arg.startsWith('--targets='));
const selectedTargetSet = new Set(
  targetArg
    ? targetArg
        .substring('--targets='.length)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : allTargets.map((entry) => entry.target),
);

const selectedTargets = allTargets.filter((entry) => selectedTargetSet.has(entry.target));

if (selectedTargets.length === 0) {
  throw new Error('No valid targets selected.');
}

const unknownTargets = [...selectedTargetSet].filter(
  (target) => !allTargets.some((entry) => entry.target === target),
);

if (unknownTargets.length > 0) {
  throw new Error(`Unsupported targets: ${unknownTargets.join(', ')}`);
}

const hostPlatformTag = process.platform === 'win32'
  ? 'win'
  : process.platform === 'darwin'
    ? 'macos'
    : process.platform;

const hostArchTag = process.arch;

for (const targetInfo of selectedTargets) {
  const outputPath = path.join(outDir, targetInfo.output);
  const targetParts = targetInfo.target.split('-');
  const targetPlatformTag = targetParts[1] ?? '';
  const targetArchTag = targetParts[2] ?? '';
  const isCrossTarget = targetPlatformTag !== hostPlatformTag || targetArchTag !== hostArchTag;

  const pkgArgs = [
    pkgCliEntry,
    distEntry,
    '--targets',
    targetInfo.target,
    '--output',
    outputPath,
    '--compress',
    'Brotli',
  ];

  if (isCrossTarget) {
    // pkg cannot always execute non-host architecture Node binaries while fabricating bytecode.
    // Disable bytecode for cross-target packaging to avoid spawn UNKNOWN/EINVAL failures.
    pkgArgs.push('--no-bytecode');
  }

  // Execute the pkg CLI via Node to avoid .cmd spawn issues on Windows runners.
  execFileSync(process.execPath, pkgArgs, {
    cwd: toolRoot,
    stdio: 'inherit',
  });
}

for (const file of fs.readdirSync(outDir)) {
  const fullPath = path.join(outDir, file);
  if (process.platform !== 'win32' && fs.statSync(fullPath).isFile() && !file.endsWith('.exe')) {
    fs.chmodSync(fullPath, 0o755);
  }
}

console.log('Packaged binaries in', outDir);
