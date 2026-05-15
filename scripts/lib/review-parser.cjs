function parseSeverityCounts(markdown) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    
    // Target the "Bugs & Failure Modes" table specifically
    const tableMatch = markdown.match(/## Bugs & Failure Modes\s*?\n([\s\S]*?)(?:\n##|$)/);
    if (!tableMatch) {
        return counts;
    }

    const table = tableMatch[1];
    const lines = table.split('\n');
    
    for (const line of lines) {
        if (!line.includes('|')) continue;
        
        // Skip header and separator lines
        if (line.includes('---') || line.toLowerCase().includes('severity')) continue;
        
        // Split by pipe and find the severity column
        const columns = line.split('|').map(c => c.trim()).filter(Boolean);
        if (columns.length < 2) continue;
        
        // Severity is usually the second column in the provided structure
        // | File:Line | Severity | Finding | Evidence |
        const severity = columns[1].toLowerCase();
        
        if (severity.includes('critical')) counts.critical++;
        else if (severity.includes('high')) counts.high++;
        else if (severity.includes('medium')) counts.medium++;
        else if (severity.includes('low')) counts.low++;
    }

    return counts;
}

function parseScore(markdown) {
    const match = markdown.match(/## Score: (\d+)\/10/);
    return match ? parseInt(match[1]) : null;
}

function hasCriticalOrHigh(markdown) {
    const counts = parseSeverityCounts(markdown);
    return counts.critical > 0 || counts.high > 0;
}

module.exports = {
    parseSeverityCounts,
    parseScore,
    hasCriticalOrHigh
};
