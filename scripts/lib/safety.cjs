const path = require('path');

function validatePatchText(patchText) {
    // Reject markdown fences
    if (patchText.includes('```')) {
        throw new Error('Patch contains markdown fences');
    }
    
    // Check if it looks like a unified diff
    if (!patchText.includes('--- ') || !patchText.includes('+++ ') || !patchText.includes('@@ ')) {
        throw new Error('Response does not appear to be a valid unified diff');
    }
    
    // Reject prose before/after diff (simple check)
    const lines = patchText.trim().split('\n');
    if (!lines[0].startsWith('--- ') && !lines[0].startsWith('Index: ') && !lines[0].startsWith('diff ')) {
        throw new Error('Patch contains prose before the diff');
    }

    return true;
}

function rejectDangerousPaths(patchText, gitRoot) {
    const lines = patchText.split('\n');
    const blockedPatterns = [
        /\.env.*/i,
        /.*\.pem$/i,
        /.*\.key$/i,
        /id_rsa/i,
        /\.npmrc$/i,
        /\.pypirc$/i
    ];

    for (const line of lines) {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            const filePath = line.substring(4).split('\t')[0].trim();
            if (filePath === '/dev/null') continue;
            
            // Remove a/ or b/ prefix
            const cleanPath = filePath.replace(/^[ab]\//, '');
            const absolutePath = path.resolve(gitRoot, cleanPath);
            const relativePath = path.relative(gitRoot, absolutePath);
            
            // Check if it's outside the git root
            if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                throw new Error(`Patch modifies file outside repository: ${cleanPath}`);
            }
            
            const base = path.basename(cleanPath);
            
            // Block sensitive files
            for (const pattern of blockedPatterns) {
                if (pattern.test(base)) {
                    throw new Error(`Patch modifies blocked sensitive file: ${cleanPath}`);
                }
            }

            if (cleanPath.startsWith('.git/')) {
                throw new Error(`Patch modifies internal git directory: ${cleanPath}`);
            }
            
            if (cleanPath.startsWith('.github/workflows/')) {
                throw new Error(`Patch modifies GitHub workflow: ${cleanPath}`);
            }
        }
    }
    return true;
}

function rejectScriptExecution(content) {
    const dangerousPatterns = [
        /#!/,
        /powershell/i,
        /pwsh/i,
        /cmd\.exe/i,
        /bash/i,
        /sh /i,
        /\.ps1/i,
        /\.sh/i,
        /\.bat/i
    ];
    
    for (const pattern of dangerousPatterns) {
        if (pattern.test(content)) {
            throw new Error(`Response contains forbidden script pattern: ${pattern}`);
        }
    }
}

module.exports = {
    validatePatchText,
    rejectDangerousPaths,
    rejectScriptExecution
};
