'use strict';

/**
 * Coverage gate.
 *
 * Parses the table node --test --experimental-test-coverage prints, and fails the
 * build if line, branch or function coverage falls below its floor. Enforced in CI so
 * coverage cannot quietly regress.
 *
 * Usage: node scripts/check-coverage.cjs [reportFile] [minLine] [minBranch] [minFuncs]
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FLOORS = { line: 85, branch: 80, funcs: 80 };

function parseReport(text) {
    const rows = [];
    for (const raw of text.split(/\r?\n/)) {
        // The table is emitted as TAP comments, so every line is prefixed with "# ".
        // Strip the marker, then trim: two spaces remain after the hash, which would
        // otherwise defeat the anchored patterns below.
        const line = raw.replace(/^#+\s?/, '').trim();
        if (!line.includes('|')) continue;

        const isTotals = /^all files\s+\|/.test(line);
        const isFile = /^[\w.-]+\.js\s+\|/.test(line);
        if (!isTotals && !isFile) continue;

        const cells = line.split('|').map((c) => c.trim());
        if (cells.length < 4) continue;
        const num = (v) => {
            const n = Number.parseFloat(v);
            return Number.isFinite(n) ? n : null;
        };
        rows.push({
            file: cells[0],
            line: num(cells[1]),
            branch: num(cells[2]),
            funcs: num(cells[3]),
        });
    }
    return rows;
}

function findTotals(rows) {
    return rows.find((r) => r.file === 'all files') || null;
}

function main() {
    const [, , reportPath, minLine, minBranch, minFuncs] = process.argv;
    const floors = {
        line: Number(minLine) || DEFAULT_FLOORS.line,
        branch: Number(minBranch) || DEFAULT_FLOORS.branch,
        funcs: Number(minFuncs) || DEFAULT_FLOORS.funcs,
    };

    const text = reportPath && fs.existsSync(reportPath)
        ? fs.readFileSync(reportPath, 'utf8')
        : fs.readFileSync(0, 'utf8');

    const rows = parseReport(text);
    if (rows.length === 0) {
        console.error('coverage: no rows parsed - refusing to pass silently');
        process.exit(1);
    }

    const totals = findTotals(rows);
    if (!totals) {
        console.error('coverage: no "all files" row found - refusing to pass silently');
        process.exit(1);
    }

    const failures = [];
    console.log('coverage floors:');
    for (const metric of ['line', 'branch', 'funcs']) {
        const actual = totals[metric];
        const floor = floors[metric];
        const ok = actual !== null && actual >= floor;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(6)} ${actual}%  (floor ${floor}%)`);
        if (!ok) failures.push(`${metric} ${actual}% < ${floor}%`);
    }

    // Report the weakest files so a regression names its cause.
    const worst = rows
        .filter((r) => r.file !== 'all files' && r.line !== null)
        .sort((a, b) => a.line - b.line)
        .slice(0, 3);
    if (worst.length) {
        console.log('weakest files by line coverage:');
        for (const w of worst) {
            console.log(`  ${String(w.line).padStart(6)}%  ${w.file}`);
        }
    }

    if (failures.length) {
        console.error(`\ncoverage gate failed: ${failures.join('; ')}`);
        process.exit(1);
    }
    console.log('\ncoverage gate passed');
}

main();
