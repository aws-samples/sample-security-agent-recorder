// ESLint flat config (ESLint 9+/10). Ported from the previous
// `.eslintrc.json`.
//
// The only enforced rule is a ban on direct `chrome.*` access outside the
// cross-browser seam at `src/shared/browser.js`; every other module must go
// through the `browser` shim. Test, build, and config files are exempt.
//
// Note: this intentionally does not extend `eslint:recommended` (matching
// the previous config), so rules like `no-undef` are not active and no
// `globals`/`env` declarations are required.

export default [
    {
        // Vendored third-party code and build output are not our source.
        ignores: ['dist/**', 'artifacts/**', 'src/vendor/**']
    },
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module'
        },
        // ESLint 9+ flat config defaults this to "warn"; the previous
        // .eslintrc setup left it off. The `eslint-disable no-console`
        // directives in the source predate any enabled `no-console` rule, so
        // keep them silent to preserve prior behavior. (They activate if a
        // `no-console` rule is ever enabled.)
        linterOptions: {
            reportUnusedDisableDirectives: 'off'
        },
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "MemberExpression[object.name='chrome']",
                    message:
                        'Direct chrome.* usage is forbidden. Import the `browser` shim from src/shared/browser.js instead.'
                },
                {
                    selector:
                        "MemberExpression[object.type='ThisExpression'][property.name='chrome']",
                    message:
                        'Direct chrome.* usage is forbidden. Import the `browser` shim from src/shared/browser.js instead.'
                }
            ]
        }
    },
    {
        // The seam is the one place allowed to reference `chrome.*`.
        files: ['src/shared/browser.js'],
        rules: { 'no-restricted-syntax': 'off' }
    },
    {
        // Test, build, and config files may reference browser APIs freely.
        files: [
            'tests/**/*.js',
            '**/*.spec.js',
            '**/*.test.js',
            'scripts/**/*.js',
            'vitest.config.js',
            'eslint.config.js'
        ],
        rules: { 'no-restricted-syntax': 'off' }
    }
];
