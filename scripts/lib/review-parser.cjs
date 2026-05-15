function parseSeverityCounts(markdown) {
    const counts = { 
        parsed: false,
        critical: null, 
        high: null, 
        medium: null, 
        low: null 
    };
    
    // Target the "Bugs & Failure Modes" table specifically
    const tableMatch = markdown.match(/## Bugs & Failure Modes\s*?\n([\s\S]*?)(?:\n##|$)/);
    if (!tableMatch) {
        return counts;
    }

    counts.parsed = true;
    counts.critical = 0;
    counts.high = 0;
    counts.medium = 0;
    counts.low = 0;

    const table = tableMatch[1].trim();
    if (!table) {
        counts.parsed = false; // Empty table is treated as unparsed
        return counts;
    }

    const lines = table.split('\n');
    let dataLineFound = false;
    
    for (const line of lines) {
        if (!line.includes('|')) continue;
        
        // Skip header and separator lines
        if (line.includes('---') || line.toLowerCase().includes('severity')) continue;
        
        // Split by pipe and find the severity column
        const columns = line.split('|').map(c => c.trim()).filter(Boolean);
        if (columns.length < 2) continue;
        
        dataLineFound = true;
        const severity = columns[1].toLowerCase();
        
        // Support text and emojis
        if (severity.includes('critical') || severity.includes('🔴')) counts.critical++;
        else if (severity.includes('high') || severity.includes('🟠')) counts.high++;
        else if (severity.includes('medium') || severity.includes('🟡')) counts.medium++;
        else if (severity.includes('low') || severity.includes('🟢')) counts.low++;
    }

    if (!dataLineFound) {
        counts.parsed = false; // No data lines found in table
    }

    return counts;
}

function parseScore(markdown) {
    // Support ## Score: 7/10, ## Score: 7.5/10, ## Score: **7/10**
    const match = markdown.match(/## Score: \**(\d+(\.\d+)?)\**\/10/);
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
    hasCriticalOrHigh
};
