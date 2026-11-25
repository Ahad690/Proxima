#!/usr/bin/env node
/**
 * Print the configured Claude model chain, and resolve the newest model per family
 * from the official Anthropic Models API when ANTHROPIC_API_KEY is set.
 *
 *   node scripts/claude-models.cjs
 *   node scripts/claude-models.cjs --write   # update the claude section of models.json
 *
 * The claude.ai web session has no models-list endpoint. Without a Console API key the
 * configured chain is the only source, which is why --write refuses to run without one.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, resolveLatest } = require('../electron/claude-models.cjs');

(async function main() {
    const repoRoot = path.join(__dirname, '..');
    const cfg = loadConfig({ repoRoot });
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    const resolved = await resolveLatest(cfg, { apiKey: apiKey });

    console.log('config:     ' + (cfg.configPath || 'built-in defaults'));
    console.log('effort:     ' + resolved.effort);
    console.log('configured: ' + cfg.models.join(' -> '));
    console.log('resolved:   ' + resolved.models.join(' -> '));
    console.log('source:     ' + resolved.source);
    console.log('api key:    ' + (apiKey ? 'present' : 'absent'));

    if (!apiKey) {
        console.log('\nNo ANTHROPIC_API_KEY. The claude.ai web session has no models-list');
        console.log('endpoint, so the configured chain above is what will be used. Set a');
        console.log('Console API key to resolve the newest id per family from GET /v1/models.');
        return;
    }

    if (resolved.error) {
        console.log('\nModels API lookup failed: ' + resolved.error);
        console.log('The configured chain is unchanged.');
        return;
    }

    if (process.argv.includes('--write')) {
        const target = cfg.configPath || path.join(repoRoot, 'models.json');
        const out = {
            effort: resolved.effort,
            autoLatest: resolved.autoLatest,
            families: resolved.families,
            models: resolved.models
        };

        // models.json is shared by every provider: replace only the claude section.
        // A legacy flat claude-models.json is still written in its original shape.
        let doc = {};
        try {
            doc = JSON.parse(fs.readFileSync(target, 'utf8')) || {};
        } catch (e) { doc = {}; }
        const legacy = /claude-models\.json$/i.test(target) ||
            (!doc.claude && Array.isArray(doc.models));

        if (legacy) {
            fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
        } else {
            doc.claude = out;
            fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
        }
        console.log('\nWrote the resolved Claude chain to ' + target);
    }
})().catch(function (e) {
    console.error('claude-models failed: ' + (e && e.message || e));
    process.exit(1);
});
