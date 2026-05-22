#!/usr/bin/env node
/**
 * Package script: runs the per-browser build and produces release zips
 * suitable for attaching to a GitHub release (and uploading to the
 * Chrome Web Store / addons.mozilla.org).
 *
 * Output (with manifest version `X.Y.Z`):
 *   dist/aws-security-agent-recorder-chrome-X.Y.Z.zip
 *   dist/aws-security-agent-recorder-firefox-X.Y.Z.zip
 *
 * Each zip contains the contents of `dist/<variant>/` — i.e. the
 * `manifest.json` is at the zip root, which is what both stores require.
 *
 * Implementation note: shells out to the system `zip` command (preinstalled
 * on macOS and most Linux distros). This keeps the build dependency-free.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const distRoot = resolve(root, 'dist');
const buildScript = resolve(here, 'build.js');

const VARIANTS = ['chrome', 'firefox'];
const PACKAGE_BASENAME = 'aws-security-agent-recorder';

// Files we don't want in a published zip even if they snuck into src/.
const ZIP_EXCLUDES = ['.DS_Store', '*/.DS_Store', '.gitkeep', '*/.gitkeep'];

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        ...options
    });
    if (result.status !== 0) {
        throw new Error(
            `[package] \`${command} ${args.join(' ')}\` exited with ` +
            `status ${result.status}`
        );
    }
}

async function readManifestVersion(variantDir) {
    const manifestPath = resolve(variantDir, 'manifest.json');
    const text = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(text);
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
        throw new Error(
            `[package] ${relative(root, manifestPath)} has no version field`
        );
    }
    return manifest.version;
}

async function packageVariant(variant) {
    const variantDir = resolve(distRoot, variant);
    if (!existsSync(variantDir)) {
        throw new Error(
            `[package] expected ${relative(root, variantDir)} to exist after build`
        );
    }
    const version = await readManifestVersion(variantDir);
    const zipName = `${PACKAGE_BASENAME}-${variant}-${version}.zip`;
    const zipPath = resolve(distRoot, zipName);
    if (existsSync(zipPath)) {
        await rm(zipPath);
    }
    const args = ['-r', '-X', zipPath, '.'];
    for (const pattern of ZIP_EXCLUDES) {
        args.push('-x', pattern);
    }
    run('zip', args, { cwd: variantDir });
    console.log(`[package] Wrote dist/${zipName}`);
}

async function main() {
    // Always rebuild from source so the zips reflect the current tree.
    run(process.execPath, [buildScript]);

    await mkdir(distRoot, { recursive: true });
    for (const variant of VARIANTS) {
        await packageVariant(variant);
    }
}

main().catch((err) => {
    console.error(`[package] Failed:`, err);
    process.exit(1);
});
