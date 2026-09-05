#!/usr/bin/env node
/**
 * Bundles the MCP server into dist/server.mjs with esbuild, then prunes
 * node_modules down to the runtime essentials.
 *
 * - Everything (server src, @modelcontextprotocol/sdk, zod, zod-to-json-schema)
 *   is bundled into a single ESM file; `node-pty` stays external because it is
 *   a native module resolved at runtime from node_modules.
 * - ESM output keeps import.meta.url working natively (the server derives its
 *   __dirname from it to locate package.json).
 * - After bundling, node_modules is pruned to a trimmed node-pty (lib +
 *   prebuilds without .pdb symbols). Because declared dependencies no longer
 *   exist on disk, vsce must run with --no-dependencies (standard for bundled
 *   extensions). npm install on the next prepublish restores everything.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'node_modules', 'smart-terminal-mcp', 'src', 'index.js');

if (!existsSync(entry)) {
    console.error(`Bundle entry not found: ${entry}\nRun npm install first.`);
    process.exit(1);
}

await build({
    entryPoints: [entry],
    outfile: join(root, 'dist', 'server.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    external: ['node-pty'],
    sourcemap: false,
    legalComments: 'inline',
    logLevel: 'info',
});
console.log('Bundled server -> dist/server.mjs');

// ── Prune node_modules to runtime essentials ────────────────────────────────
const rmOpts = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
// esbuild/@esbuild stay on disk: Windows keeps the bundler binary locked during
// the build; they are excluded from the VSIX via .vscodeignore instead.
const KEEP = new Set(['node-pty', 'node-addon-api', 'esbuild', '@esbuild']);
const nmDir = join(root, 'node_modules');
for (const entryName of readdirSync(nmDir)) {
    if (!KEEP.has(entryName)) {
        rmSync(join(nmDir, entryName), rmOpts);
    }
}

const ptyDir = join(nmDir, 'node-pty');
for (const junk of ['deps', 'src', 'third_party', 'scripts', 'typings', 'build', '.github', 'test']) {
    rmSync(join(ptyDir, junk), rmOpts);
}
for (const junkFile of [
    'binding.gyp', 'tsconfig.json', '.eslintrc.js', '.prettierrc',
    '.editorconfig', '.drone.yml', '.npmignore', 'README.md', '.gitattributes',
]) {
    rmSync(join(ptyDir, junkFile), { force: true });
}

const dropSuffixes = ['.test.js', '.js.map', '.pdb'];
for (const dirName of ['lib', 'prebuilds']) {
    for (const file of readdirSync(join(ptyDir, dirName), { recursive: true })) {
        const rel = String(file);
        if (dropSuffixes.some((suffix) => rel.endsWith(suffix))) {
            rmSync(join(ptyDir, dirName, rel), { force: true, maxRetries: 10, retryDelay: 200 });
        }
    }
}
console.log('Pruned node_modules (kept node-pty trimmed; esbuild stays on disk, excluded via .vscodeignore)');
