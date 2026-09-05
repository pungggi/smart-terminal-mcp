#!/usr/bin/env node
/**
 * Afterpublish script for the Smart Terminal MCP extension.
 *
 * Nothing to revert (no dist swap like MQL Clangd): the extension runs from
 * extension.js and the server is bundled from node_modules. Just remind about
 * the package.json changes that prepublish made, so they get committed.
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');

try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(`Done (version ${pkg.version}).`);
    console.log('Remember to commit the synced vscode-extension/package.json and any CHANGELOG entry.');
} catch (error) {
    console.error('Error in afterpublish.js:', error.message);
    process.exit(1);
}
