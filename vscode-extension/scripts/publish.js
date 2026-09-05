#!/usr/bin/env node
/**
 * Publish script for the Smart Terminal MCP extension.
 * Mirrors the MQL Clangd publishing workflow.
 *
 * Usage: node scripts/publish.js <vsce|ovsx> [--pre-release]
 *
 * Credentials come from .vscode/.env.json (gitignored):
 *   { "VSCE_PAT": "...", "OVSX_PAT": "..." }
 */
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const target = args.find(arg => ['vsce', 'ovsx'].includes(arg));
const isPreRelease = args.includes('--pre-release');

if (!target) {
    console.error('Usage: node scripts/publish.js <vsce|ovsx> [--pre-release]');
    process.exit(1);
}

let env;
try {
    env = require('../.vscode/.env.json');
} catch (e) {
    console.error('Error: .vscode/.env.json not found. Create it with VSCE_PAT and OVSX_PAT keys.');
    process.exit(1);
}

const pat = target === 'vsce' ? env.VSCE_PAT : env.OVSX_PAT;

if (!pat) {
    console.error(`Error: ${target.toUpperCase()}_PAT not found in .vscode/.env.json`);
    process.exit(1);
}

const cmd = `npx ${target === 'vsce' ? 'vsce' : 'ovsx'} publish${isPreRelease ? ' --pre-release' : ''}`;
console.log(`Publishing to ${target.toUpperCase()}${isPreRelease ? ' (Pre-Release)' : ''}...`);

// vsce reads package.json before running the vscode:prepublish hook, so the
// version/dependency sync + npm install must happen before it is invoked.
execSync('node scripts/prepublish.js', { stdio: 'inherit' });

const envWithPat = { ...process.env };
if (target === 'vsce') {
    envWithPat.VSCE_PAT = pat;
} else {
    envWithPat.OVSX_PAT = pat;
}

try {
    execSync(cmd, { stdio: 'inherit', env: envWithPat });
} catch (e) {
    try {
        execSync('node scripts/afterpublish.js', { stdio: 'inherit' });
    } catch (afterErr) {
        console.error('Failed to run afterpublish:', afterErr.message);
    }
    process.exit(1);
}

try {
    execSync('node scripts/afterpublish.js', { stdio: 'inherit' });
} catch (e) {
    console.error('WARNING: afterpublish failed:', e.message);
}
