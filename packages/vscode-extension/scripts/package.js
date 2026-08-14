#!/usr/bin/env node
/**
 * Packages the extension into a .vsix, working entirely inside a scratch
 * directory rather than this workspace's own node_modules.
 *
 * Why: `a11y-autofix` is a `file:../..` workspace dependency, which npm
 * links as a *symlink* into node_modules. `vsce package` refuses to
 * package a file that resolves outside the extension's own directory
 * through a symlink (a real zip-slip safety check, confirmed by actually
 * running it against the raw symlinked node_modules) — the symlink target
 * is this monorepo's root, and vsce trips over the root's own files (e.g.
 * `vitest.config.ts`) sitting right there. The fix is to give the scratch
 * copy a *tarball* dependency instead of a directory one: `npm install`
 * always extracts a tarball into a real, non-symlinked copy, which is
 * exactly what an end user's real npm install would produce too.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extensionDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionDir, '..', '..');

function run(command, args, cwd) {
  console.log(`+ ${command} ${args.join(' ')} (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function main() {
  // Build both packages for real first — the scratch copy reuses these
  // build outputs rather than reinstalling dev tooling (typescript,
  // @types/vscode) into a second, throwaway node_modules.
  run('npm', ['run', 'build'], repoRoot);
  run('npm', ['run', 'build'], extensionDir);

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-autofix-vsix-'));
  console.log(`Packaging in scratch dir: ${scratchDir}`);

  try {
    for (const entry of ['package.json', 'README.md', 'LICENSE', '.vscodeignore', 'dist']) {
      fs.cpSync(path.join(extensionDir, entry), path.join(scratchDir, entry), { recursive: true });
    }

    const tarballName = execFileSync('npm', ['pack', '--pack-destination', scratchDir], {
      cwd: repoRoot,
    })
      .toString()
      .trim()
      .split('\n')
      .pop();
    if (!tarballName) throw new Error('npm pack produced no tarball filename');

    const manifestPath = path.join(scratchDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['a11y-autofix'] = `file:./${tarballName}`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], scratchDir);

    // npm workspaces hoists devDependency binaries to the monorepo root's
    // node_modules/.bin, not a local one under the extension package.
    const vsceBin = path.join(repoRoot, 'node_modules', '.bin', 'vsce');
    run(vsceBin, ['package'], scratchDir);

    const vsix = fs.readdirSync(scratchDir).find((f) => f.endsWith('.vsix'));
    if (!vsix) throw new Error('vsce package did not produce a .vsix');
    fs.copyFileSync(path.join(scratchDir, vsix), path.join(extensionDir, vsix));
    console.log(`\nWrote ${path.join(extensionDir, vsix)}`);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main();
