#!/usr/bin/env node
/**
 * Prepublish script for the Smart Terminal MCP extension.
 *
 * Runs before vsce reads package.json:
 *  1. Syncs the extension version (and the pinned `smart-terminal-mcp`
 *     dependency) to the server version in the repo root package.json.
 *  2. Installs the dependency tree so the server + node-pty prebuilds get
 *     bundled into the VSIX.
 *  3. Sanity-checks the bundled server entry point and reports which
 *     node-pty prebuilds are included.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const extDir = path.join(__dirname, '..');
const rootPkgPath = path.join(extDir, '..', 'package.json');
const pkgPath = path.join(extDir, 'package.json');

try {
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    pkg.version = rootPkg.version;
    pkg.devDependencies = pkg.devDependencies || {};
    pkg.devDependencies['smart-terminal-mcp'] = rootPkg.version; // bundler input, pruned after build

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
    console.log(`Synced extension version + dependency to smart-terminal-mcp@${rootPkg.version}`);

    execSync('npm install --no-audit --no-fund', { cwd: extDir, stdio: 'inherit' });
    execSync('node scripts/bundle.mjs', { cwd: extDir, stdio: 'inherit' });

    const entry = path.join(extDir, 'dist', 'server.mjs');
    if (!fs.existsSync(entry)) {
        throw new Error(`Bundled server not found: ${entry}`);
    }

    const prebuildsDir = path.join(extDir, 'node_modules', 'node-pty', 'prebuilds');
    const platforms = fs.existsSync(prebuildsDir)
        ? fs.readdirSync(prebuildsDir).join(', ')
        : 'NONE (Linux will fall back to npx)';
    console.log(`Bundled node-pty prebuilds: ${platforms}`);
    console.log('Prepublish complete.');
} catch (error) {
    console.error('Error in prepublish.js:', error.message);
    process.exit(1);
}
