// Feature: domain-recorder-extension, Task 10.2: Static contracts
// Validates: Requirements 1.3, 5.1, 10.2, 10.3, 10.4
//
// Walks src/ and asserts a handful of static contracts that are easier to
// verify by file inspection than by runtime tests:
//
//   - Req 1.3: every cross-browser API call goes through the seam at
//     `src/shared/browser.js`; no other file references `chrome.*`.
//   - Reqs 5.1, 10.2: only `storage.local` is used; the extension never
//     reads from or writes to `storage.sync`, `storage.session`, or
//     `storage.managed`.
//   - Req 10.3: the extension never makes outbound network requests; no
//     `fetch(`, `XMLHttpRequest`, `navigator.sendBeacon`, or
//     `new WebSocket(` appears anywhere under `src/`.
//   - Req 10.4: HTML pages do not load scripts from remote URLs and no
//     bare-specifier (third-party) ES module imports are used anywhere
//     under `src/`. The single allowed bare specifier is
//     `'webextension-polyfill'`, and only inside `src/shared/browser.js`.
//
// The vendored polyfill at `src/vendor/browser-polyfill.min.js` is
// skipped: vendoring third-party code at build time is allowed by the
// design; Req 10.4 forbids loading scripts at runtime from URLs and
// importing third-party SDKs from source modules.

import { describe, it, expect } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep, posix } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const srcRoot = resolve(repoRoot, 'src');

/** File extensions we treat as text. Anything else (.png, .gitkeep, ...) is skipped. */
const TEXT_EXTENSIONS = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.html',
    '.json',
    '.css',
    '.map'
]);

/** Path (relative to the repo root, with forward slashes) of the seam module. */
const BROWSER_SEAM = 'src/shared/browser.js';

/** Path (relative to the repo root, with forward slashes) of the vendored polyfill. */
const VENDORED_POLYFILL = 'src/vendor/browser-polyfill.min.js';

/**
 * Convert a platform-native absolute path to a repo-root-relative path that
 * uses forward slashes regardless of OS. Comparisons against the
 * BROWSER_SEAM / VENDORED_POLYFILL constants assume forward slashes.
 *
 * @param {string} absPath
 * @returns {string}
 */
function toRepoRelative(absPath) {
    return relative(repoRoot, absPath).split(sep).join(posix.sep);
}

/**
 * Recursively walk `dir`, yielding every text file under it (filtered by
 * TEXT_EXTENSIONS). Returns an array of `{ absPath, repoRelPath, ext }`
 * descriptors. Symlinks and directories starting with `.` (e.g. `.git`)
 * are skipped, but `.gitkeep` placeholder files are simply excluded by
 * the extension filter.
 *
 * @param {string} dir
 * @returns {Promise<Array<{ absPath: string, repoRelPath: string, ext: string }>>}
 */
async function collectTextFiles(dir) {
    const out = [];
    /** @type {string[]} */
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                // Skip hidden files like .gitkeep / .DS_Store.
                continue;
            }
            const abs = resolve(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(abs);
                continue;
            }
            if (!entry.isFile()) {
                // Skip symlinks, sockets, etc.
                continue;
            }
            const repoRelPath = toRepoRelative(abs);
            if (repoRelPath === VENDORED_POLYFILL) {
                continue;
            }
            const dotIdx = entry.name.lastIndexOf('.');
            const ext = dotIdx === -1 ? '' : entry.name.slice(dotIdx).toLowerCase();
            if (!TEXT_EXTENSIONS.has(ext)) {
                continue;
            }
            out.push({ absPath: abs, repoRelPath, ext });
        }
    }
    out.sort((a, b) => (a.repoRelPath < b.repoRelPath ? -1 : 1));
    return out;
}

/**
 * Eagerly read every text file under `src/` once and return a list of
 * `{ repoRelPath, ext, content }` records. Doing the I/O once and sharing
 * the result across `it` blocks keeps the test suite snappy and surfaces
 * read failures as a single, easy-to-diagnose error.
 *
 * @returns {Promise<Array<{ repoRelPath: string, ext: string, content: string }>>}
 */
async function loadSrcTextFiles() {
    // Sanity check: src/ must exist before we walk it.
    const info = await stat(srcRoot);
    if (!info.isDirectory()) {
        throw new Error(`expected src/ to be a directory at ${srcRoot}`);
    }
    const files = await collectTextFiles(srcRoot);
    return Promise.all(
        files.map(async (f) => ({
            repoRelPath: f.repoRelPath,
            ext: f.ext,
            content: await readFile(f.absPath, 'utf8')
        }))
    );
}

/**
 * Strip line and block comments from a JavaScript-like source string. The
 * goal is to avoid false-positive matches inside source comments
 * (descriptive text, JSDoc examples) when the production code itself is
 * compliant. The implementation is a tiny single-pass tokenizer that
 * tracks string and template literals so that contents of strings are
 * preserved (banned APIs inside a string would be a bug worth catching).
 *
 * Note: this does not need to be a full JS parser. It only needs to
 * remove the obvious comment forms used in the codebase. JSON and CSS
 * files are passed through unchanged by the caller.
 *
 * @param {string} source
 * @returns {string}
 */
function stripJsComments(source) {
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
        const c = source[i];
        const next = i + 1 < n ? source[i + 1] : '';

        // Line comment: keep the newline so line numbers / regex anchors
        // stay accurate, but drop everything else on the line.
        if (c === '/' && next === '/') {
            i += 2;
            while (i < n && source[i] !== '\n') {
                i += 1;
            }
            continue;
        }

        // Block comment: replace the whole comment with a single space so
        // adjacent tokens do not accidentally merge (e.g. `a/*x*/b`).
        if (c === '/' && next === '*') {
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
                i += 1;
            }
            i += 2; // skip the closing */
            out += ' ';
            continue;
        }

        // String literal: copy through unchanged, honoring backslash escapes.
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += c;
            i += 1;
            while (i < n) {
                const ch = source[i];
                out += ch;
                if (ch === '\\' && i + 1 < n) {
                    out += source[i + 1];
                    i += 2;
                    continue;
                }
                i += 1;
                if (ch === quote) {
                    break;
                }
            }
            continue;
        }

        out += c;
        i += 1;
    }
    return out;
}

/**
 * Strip HTML comments (`<!-- ... -->`) from an HTML source string.
 *
 * @param {string} source
 * @returns {string}
 */
function stripHtmlComments(source) {
    return source.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Return the comment-stripped form of `record.content`, or the content
 * unchanged for file types where stripping is unnecessary.
 *
 * @param {{ ext: string, content: string }} record
 * @returns {string}
 */
function stripComments(record) {
    if (record.ext === '.js' || record.ext === '.mjs' || record.ext === '.cjs') {
        return stripJsComments(record.content);
    }
    if (record.ext === '.html') {
        return stripHtmlComments(record.content);
    }
    return record.content;
}

/**
 * Extract every ES-module specifier statically referenced from a JS
 * source string: `import ... from 'spec'`, bare `import 'spec'`, and
 * dynamic `import('spec')`. Multi-line `import { ... } from 'spec'`
 * forms are handled because the `from` clause is matched in isolation.
 *
 * Re-exports (`export ... from 'spec'`) are also captured so a
 * third-party re-export would be flagged.
 *
 * @param {string} source
 * @returns {string[]}
 */
function collectModuleSpecifiers(source) {
    const specifiers = [];
    const patterns = [
        // import 'foo';
        /(^|[^A-Za-z0-9_$])import\s+(['"])([^'"]+)\2/g,
        // import x from 'foo'; import { a } from 'foo'; etc.
        /(^|[^A-Za-z0-9_$])from\s+(['"])([^'"]+)\2/g,
        // dynamic import('foo')
        /(^|[^A-Za-z0-9_$])import\s*\(\s*(['"])([^'"]+)\2\s*\)/g
    ];
    for (const re of patterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(source)) !== null) {
            specifiers.push(match[3]);
        }
    }
    return specifiers;
}

/**
 * Lazily-loaded cache of every text file under src/. Vitest does not run
 * `describe` blocks in parallel within a file, so a top-level promise
 * shared across tests is safe and keeps the suite cheap.
 *
 * @type {Promise<Array<{ repoRelPath: string, ext: string, content: string }>> | null}
 */
let cachedFiles = null;

/**
 * @returns {Promise<Array<{ repoRelPath: string, ext: string, content: string }>>}
 */
function getSrcFiles() {
    if (!cachedFiles) {
        cachedFiles = loadSrcTextFiles();
    }
    return cachedFiles;
}

describe('static contracts in src/', () => {
    it('walks src/ and finds files to inspect', async () => {
        const files = await getSrcFiles();
        // A trivially empty list would silently pass every other rule; guard
        // against that by asserting we actually picked up the modules we
        // expect to inspect.
        const paths = files.map((f) => f.repoRelPath);
        expect(paths).toContain('src/manifest.json');
        expect(paths).toContain('src/shared/browser.js');
        expect(paths).toContain('src/background/service-worker.js');
        // Vendored polyfill must NOT appear: it is the documented exception.
        expect(paths).not.toContain(VENDORED_POLYFILL);
    });

    it('does not reference `chrome.` outside the seam at src/shared/browser.js (Req 1.3)', async () => {
        const files = await getSrcFiles();
        const chromePattern = /\bchrome\./;
        const offenders = [];
        for (const file of files) {
            if (file.repoRelPath === BROWSER_SEAM) {
                continue;
            }
            const stripped = stripComments(file);
            if (chromePattern.test(stripped)) {
                offenders.push(file.repoRelPath);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('does not reference storage.sync, storage.session, or storage.managed (Reqs 5.1, 10.2)', async () => {
        const files = await getSrcFiles();
        const banned = ['storage.sync', 'storage.session', 'storage.managed'];
        const offenders = [];
        for (const file of files) {
            const stripped = stripComments(file);
            for (const needle of banned) {
                if (stripped.includes(needle)) {
                    offenders.push({ file: file.repoRelPath, needle });
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('does not reference banned network APIs (Req 10.3)', async () => {
        const files = await getSrcFiles();
        // `fetch(` and `navigator.sendBeacon` are matched as substrings;
        // `XMLHttpRequest` is a unique identifier; `new WebSocket(`
        // matches the constructor specifically.
        const banned = ['fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', 'new WebSocket('];
        const offenders = [];
        for (const file of files) {
            const stripped = stripComments(file);
            for (const needle of banned) {
                if (stripped.includes(needle)) {
                    offenders.push({ file: file.repoRelPath, needle });
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('does not load scripts from remote URLs in any HTML page (Req 10.4)', async () => {
        const files = await getSrcFiles();
        const remoteScript = /<script[^>]*src=["']https?:/i;
        const offenders = [];
        for (const file of files) {
            if (file.ext !== '.html') {
                continue;
            }
            const stripped = stripComments(file);
            if (remoteScript.test(stripped)) {
                offenders.push(file.repoRelPath);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('uses no third-party SDK imports under src/ (Req 10.4)', async () => {
        const files = await getSrcFiles();
        const offenders = [];
        for (const file of files) {
            if (
                file.ext !== '.js' &&
                file.ext !== '.mjs' &&
                file.ext !== '.cjs'
            ) {
                continue;
            }
            const stripped = stripComments(file);
            const specifiers = collectModuleSpecifiers(stripped);
            for (const spec of specifiers) {
                // Relative imports are allowed everywhere.
                if (spec.startsWith('./') || spec.startsWith('../')) {
                    continue;
                }
                // The vendored polyfill is consumed via the bare specifier
                // `webextension-polyfill`. The build step rewrites this to
                // the vendored file, so it is the only allowed bare
                // specifier and only the seam module may use it.
                if (
                    spec === 'webextension-polyfill' &&
                    file.repoRelPath === BROWSER_SEAM
                ) {
                    continue;
                }
                offenders.push({ file: file.repoRelPath, specifier: spec });
            }
        }
        expect(offenders).toEqual([]);
    });
});
