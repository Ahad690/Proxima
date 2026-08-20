// Parses the reviewer's markdown into machine-readable severity counts.
//
// TWO FORMATS ARE SUPPORTED, because the review prompt has used both:
//
//   1. Per-finding headings (current, from the b402e42 audit prompt):
//        ### Finding 1 — `src/a.js:L10-L20` — 🔴 Critical
//      The table was deliberately dropped there — "code blocks render badly in
//      table cells and let findings hide without code".
//
//   2. A markdown table (the older format), one row per finding with the
//      severity in the second column.
//
// "None found." IS A VALID, PARSED RESULT — not a parse failure. The prompt
// explicitly permits it ("NONE IS A VALID ANSWER"), because instructing the
// model to always produce findings made it fabricate them. Treating an empty
// section as unparseable meant a PERFECT review aborted the automation loop
// with review-parse-failed-needs-human-review, i.e. the cleaner the code, the
// more reliably the loop failed. That was the bug; this is the fix.

const NONE_RE = /\b(none found|no findings|none beyond findings above|no issues found)\b/i;

function severityFrom(text) {
    const sev = String(text || '').toLowerCase();
    // Text label wins over emoji: a row reading "Low 🔴" is Low. Emoji is only
    // consulted when no word appears.
    if (sev.includes('critical')) return 'critical';
    if (sev.includes('high')) return 'high';
    if (sev.includes('medium')) return 'medium';
    if (sev.includes('low')) return 'low';
    if (sev.includes('🔴')) return 'critical';
    if (sev.includes('🟠') || sev.includes('⚠️')) return 'high';
    if (sev.includes('🟡')) return 'medium';
    if (sev.includes('🟢')) return 'low';
    return null;
}

function parseSeverityCounts(markdown) {
    const counts = { parsed: false, critical: null, high: null, medium: null, low: null };

    // (?!#) matters: findings are "### Finding N", and a bare \n## boundary would
    // truncate the section at the FIRST finding, silently under-counting to 1.
    const tableMatch = String(markdown || '').match(/## Bugs & Failure Modes\s*?\n([\s\S]*?)(?:\n##(?!#)|$)/);
    if (!tableMatch) return counts;

    const section = tableMatch[1].trim();
    if (!section) return counts;   // heading present but nothing under it — genuinely malformed

    counts.parsed = true;
    counts.critical = 0; counts.high = 0; counts.medium = 0; counts.low = 0;

    // Format 1 — per-finding headings.
    const findingLines = section.split('\n').filter(l => /^###\s+Finding\b/i.test(l.trim()));
    if (findingLines.length > 0) {
        for (const line of findingLines) {
            const sev = severityFrom(line);
            if (sev) counts[sev]++;
        }
        return counts;
    }

    // Format 2 — markdown table.
    let dataLineFound = false;
    for (const line of section.split('\n')) {
        if (!line.includes('|')) continue;
        if (line.includes('---') || line.toLowerCase().includes('severity')) continue;
        const columns = line.split('|').map(c => c.trim()).filter(Boolean);
        if (columns.length < 2) continue;
        dataLineFound = true;
        const sev = severityFrom(columns[1]);
        if (sev) counts[sev]++;
    }
    if (dataLineFound) return counts;

    // Neither format produced a finding. An explicit "None found." is a real,
    // trustworthy zero. Anything else under this heading we do not understand,
    // so fail closed by reporting unparsed.
    if (NONE_RE.test(section)) return counts;

    counts.parsed = false;
    counts.critical = counts.high = counts.medium = counts.low = null;
    return counts;
}

function parseScore(markdown) {
    // Accepts "## Score: 7/10", "7.5/10", "**7/10**", and the older
    // "## Overall Score: 7/10".
    const match = String(markdown || '').match(/##\s*(?:Overall\s+)?Score:\s*\**(\d+(?:\.\d+)?)\**\s*\/\s*10/i);
    return match ? parseFloat(match[1]) : null;
}

function hasCriticalOrHigh(markdown) {
    const counts = parseSeverityCounts(markdown);
    if (!counts.parsed) return true; // Assume danger if we can't parse
    return (counts.critical || 0) > 0 || (counts.high || 0) > 0;
}

module.exports = {
    parseSeverityCounts,
    parseScore,
    hasCriticalOrHigh,
};
