#!/usr/bin/env node
/**
 * Print every provider's configured model chain, newest first.
 *
 *   node scripts/models.cjs
 *
 * The Claude-specific resolver (including the Anthropic Models API) is:
 *   npm run claude:models
 */
const path = require('path');
const { createRegistry } = require('../electron/model-registry.cjs');

const registry = createRegistry({
    repoRoot: path.join(__dirname, '..'),
    env: process.env,
    logger: console
});
const info = registry.describe();

console.log('config: ' + (info.configPath || 'built-in defaults'));
console.log('state:  ' + (info.statePath || 'in-memory'));
for (const provider of Object.keys(info.providers)) {
    const chain = info.providers[provider].chain;
    console.log('  ' + provider.padEnd(11) + (chain.length ? chain.join(' -> ') : '(engine default)'));
}
