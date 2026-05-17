const path = require('path');

function validatePatchText(patchText) {
    // Reject OpenAI's *** Begin Patch format (not a standard unified diff)
    if (patchText.includes('*** Begin Patch') || patchText.includes('*** End Patch')) {
        throw new Error('Response uses OpenAI *** Begin Patch format — not a valid unified diff. Retry with explicit prompt.');
    }

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
    // Patterns that indicate actual shell *execution* — not mere string references
    // These match shell shebang lines or spawn/exec calls with these interpreters
    const executionPatterns = [
        /^#!.*\/(bash|sh|zsh|pwsh|powershell)/i,   // shebang lines
        /`[^`]*(powershell|bash|cmd\.exe|pwsh)[^`]*`/,  // backtick execution
        /exec(?:Sync|File)?\s*\(\s*['"](?:powershell|bash|cmd\.exe|pwsh)/i,  // execSync("powershell...")
        /spawn\s*\(\s*['"](?:bash|sh|zsh|pwsh)\s*['"]/i,  // spawn("bash")
    ];

    // Patterns that look like new script FILES being created
    const newScriptFilePatterns = [
        /\+\+\+ b\/.*\.ps1\b/,
        /\+\+\+ b\/.*\.sh\b/,
        /\+\+\+ b\/.*\.bat\b/,
        /\+\+\+ b\/.*\.cmd\b/,
    ];

    // Check for new script files being created by patch
    for (const pattern of newScriptFilePatterns) {
        if (pattern.test(content)) {
            throw new Error(`Patch creates a new shell script file, which is not allowed: ${pattern}`);
        }
    }

    // For execution patterns, only scan lines that are actual shebang/top-level lines
    // (not + lines inside source code files where they're string arguments)
    const lines = content.split('\n');
    let inSourceFile = false;

    for (const line of lines) {
        // Track which file we're in
        if (line.startsWith('+++ b/')) {
            const filePath = line.substring(6).split('\t')[0].trim();
            const ext = filePath.split('.').pop().toLowerCase();
            // These extensions are source code — strings inside them are not execution
            inSourceFile = ['cjs', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'java', 'cs'].includes(ext);
            continue;
        }

        // Skip string literals inside source files
        if (inSourceFile) continue;

        // Only check added lines in non-source files
        if (!line.startsWith('+')) continue;

        for (const pattern of executionPatterns) {
            if (pattern.test(line)) {
                throw new Error(`Response contains forbidden script execution pattern in patch: ${pattern}`);
            }
        }
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
