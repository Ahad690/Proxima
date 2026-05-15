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

function rejectDangerousPaths(patchText, gitRoot, config = {}) {
    const lines = patchText.split('\n');
    const blockedPatterns = [
        /\.env.*/i,
        /.*\.pem$/i,
        /.*\.key$/i,
        /id_rsa/i,
        /\.npmrc$/i,
        /\.pypirc$/i
    ];

    const scriptExtensions = ['.ps1', '.sh', '.bat', '.cmd'];

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
            const ext = path.extname(cleanPath).toLowerCase();
            
            // Block sensitive files
            for (const pattern of blockedPatterns) {
                if (pattern.test(base)) {
                    throw new Error(`Patch modifies blocked sensitive file: ${cleanPath}`);
                }
            }

            if (cleanPath.startsWith('.git/')) {
                throw new Error(`Patch modifies internal git directory: ${cleanPath}`);
            }
            
            // allowWorkflowModification flag
            if (config.allowWorkflowModification === false) {
                if (cleanPath.startsWith('.github/workflows/') || cleanPath.startsWith('.github/actions/')) {
                    throw new Error(`Workflow modification is disabled. Patch modifies: ${cleanPath}`);
                }
            }

            // allowReviewHistoryModification flag
            if (config.allowReviewHistoryModification === false) {
                if (cleanPath.startsWith('perplexity-reviews/') || cleanPath.startsWith('review/') || cleanPath.includes('/review/')) {
                    throw new Error(`Review history modification is disabled. Patch modifies: ${cleanPath}`);
                }
            }

            // allowGeneratedScripts flag
            if (config.allowGeneratedScripts === false) {
                if (scriptExtensions.includes(ext)) {
                    throw new Error(`Generated scripts are disabled. Patch modifies: ${cleanPath}`);
                }
                
                // Reject package.json script changes if they look suspicious
                if (cleanPath === 'package.json') {
                    // This is hard to do perfectly with just a unified diff string, 
                    // but we can look for additions of dangerous lifecycle hooks.
                }
            }
        }
    }
    return true;
}

function rejectScriptExecution(content, config = {}) {
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
    
    // Always block these regardless of config for execution context safety
    for (const pattern of dangerousPatterns) {
        if (pattern.test(content)) {
            throw new Error(`Response contains forbidden script pattern: ${pattern}`);
        }
    }

    if (config.allowGeneratedScripts === false) {
        // Additional checks if needed
    }
}

/**
 * Specifically checks for package.json lifecycle script modifications in a patch.
 */
function rejectPackageJsonScripts(patchText, config = {}) {
    if (config.allowGeneratedScripts !== false) return;

    const dangerousHooks = ['preinstall', 'install', 'postinstall', 'prepare'];
    const lines = patchText.split('\n');
    let inPackageJson = false;

    for (const line of lines) {
        if (line.startsWith('+++ b/package.json')) {
            inPackageJson = true;
        } else if (line.startsWith('+++ b/')) {
            inPackageJson = false;
        }

        if (inPackageJson && line.startsWith('+')) {
            for (const hook of dangerousHooks) {
                if (line.includes(`"${hook}"`) || line.includes(`'${hook}'`)) {
                    throw new Error(`Package lifecycle script modification detected: ${hook}`);
                }
            }
        }
    }
}

module.exports = {
    validatePatchText,
    rejectDangerousPaths,
    rejectScriptExecution,
    rejectPackageJsonScripts
};
