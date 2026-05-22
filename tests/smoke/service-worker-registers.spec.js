// Feature: domain-recorder-extension, Task 6.1: Service worker smoke
//
// Asserts that importing src/background/service-worker.js under Node with
// a mock `browser` does not throw, registers all top-level listeners
// idempotently, and exposes the message dispatcher contract.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createMockBrowser } from '../helpers/mockBrowser.js';

// Replace the `webextension-polyfill` import with our mock so the
// service-worker (via src/shared/browser.js) sees the in-memory browser.
let mockBrowser = createMockBrowser();
vi.mock('webextension-polyfill', () => ({
    default: mockBrowser,
    browser: mockBrowser
}));

async function freshImport() {
    // Reset the mock and module registry so each test gets a clean slate.
    mockBrowser = createMockBrowser();
    vi.doMock('webextension-polyfill', () => ({
        default: mockBrowser,
        browser: mockBrowser
    }));
    vi.resetModules();
    return import('../../src/background/service-worker.js');
}

describe('background service worker registration', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('imports without throwing and registers all top-level listeners', async () => {
        const mod = await freshImport();

        // Bootstrap is fire-and-forget at module load; let it resolve.
        await new Promise((r) => setTimeout(r, 0));

        expect(mod.__test__.listenersRegistered()).toBe(true);
        expect(
            mockBrowser._events.runtimeOnStartup.hasListeners()
        ).toBe(true);
        expect(
            mockBrowser._events.runtimeOnInstalled.hasListeners()
        ).toBe(true);
        expect(
            mockBrowser._events.runtimeOnMessage.hasListeners()
        ).toBe(true);
        expect(
            mockBrowser._events.storageOnChanged.hasListeners()
        ).toBe(true);
        expect(
            mockBrowser._events.webRequestOnBeforeRequest.hasListeners()
        ).toBe(true);
    });

    it('is idempotent on repeated registerListeners calls', async () => {
        const mod = await freshImport();
        await new Promise((r) => setTimeout(r, 0));

        const before =
            mockBrowser._events.runtimeOnMessage._listeners().length;
        mod.registerListeners();
        mod.registerListeners();
        const after =
            mockBrowser._events.runtimeOnMessage._listeners().length;

        expect(after).toBe(before);
    });

    it('GET_STATUS returns the bootstrapped state and count', async () => {
        await freshImport();
        await new Promise((r) => setTimeout(r, 0));

        const responses = await mockBrowser._fireRuntimeMessage({
            type: 'GET_STATUS'
        });
        const reply = await responses[0];

        expect(reply).toMatchObject({ ok: true, state: 'idle', count: 0 });
        expect(reply.list).toEqual([]);
        expect(reply.targetDomain).toBeNull();
    });

    it('drops webRequest events when not recording (Req 3.8)', async () => {
        const mod = await freshImport();
        await new Promise((r) => setTimeout(r, 0));

        await mockBrowser._fireWebRequest({ url: 'https://example.com/x' });

        // Bootstrap persists an empty default list, so storage holds []
        // rather than undefined; the key check is that the list stayed
        // empty because the worker is not recording.
        expect(mockBrowser._storageSnapshot().domainList).toEqual([]);
        expect(mod.__test__.getCachedList()).toEqual([]);
        expect(mod.__test__.getCachedState()).toBe('idle');
    });
});
