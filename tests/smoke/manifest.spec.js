// Feature: domain-recorder-extension, Task 10.1: Manifest contract test
// Validates: Requirements 10.1, 10.2

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const manifestPath = resolve(__dirname, '../../src/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('manifest contract', () => {
    it('declares exactly the required permissions', () => {
        expect(manifest.permissions).toEqual([
            'webRequest',
            'storage',
            'tabs',
            'scripting',
            'activeTab'
        ]);
    });

    it('declares exactly the required host permissions', () => {
        expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
    });

    it('uses Manifest V3', () => {
        expect(manifest.manifest_version).toBe(3);
    });

    it('declares the background as an ES module', () => {
        expect(manifest.background.type).toBe('module');
    });

    it('declares both Chrome (service_worker) and Firefox (scripts) background entry points', () => {
        expect(manifest.background.service_worker).toBe('background/service-worker.js');
        expect(manifest.background.scripts).toEqual(['background/service-worker.js']);
    });

    it('declares Firefox strict_min_version 140.0', () => {
        expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('140.0');
    });

    it('declares Firefox for Android strict_min_version 142.0 (data_collection_permissions needs 142 on Android)', () => {
        expect(manifest.browser_specific_settings.gecko_android.strict_min_version).toBe('142.0');
    });

    it('declares minimum_chrome_version 138', () => {
        expect(manifest.minimum_chrome_version).toBe('138');
    });

    it('declares the autofill content script for the AWS Security Agent host', () => {
        expect(Array.isArray(manifest.content_scripts)).toBe(true);
        expect(manifest.content_scripts.length).toBeGreaterThanOrEqual(1);
        const cs = manifest.content_scripts[0];
        expect(cs.matches).toEqual([
            'https://*.securityagent.global.app.aws/*'
        ]);
        expect(cs.js).toEqual(['content/autofill.js']);
    });
});
