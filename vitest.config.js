import { defineConfig } from 'vitest/config';

// Default test environment is Node. Individual test files may override the
// environment to `jsdom` (for popup and results-page DOM tests) using the
// per-file pragma:
//
//   // @vitest-environment jsdom
//
// at the top of the file.
export default defineConfig({
    test: {
        environment: 'node',
        include: [
            'tests/**/*.spec.js',
            'tests/**/*.test.js',
            'src/**/*.spec.js',
            'src/**/*.test.js'
        ]
    }
});
