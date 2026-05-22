// Background service worker for the AWS Security Agent Recorder.
//
// Recording is scoped to a single tab. When the user starts a session:
//   1. The active tab id is captured and persisted as `sessionTabId`.
//   2. The active tab's URL is read; its origin is persisted as
//      `targetDomain`.
//   3. The accessible-URL list and the autofill-accepted (`filledUrls`)
//      set are reset so checkmarks track the current session only.
//   4. The tab is reloaded so the recorder observes its full request set.
//   5. The pastel purple/blue recording border is injected via the
//      `tabs.onUpdated` listener once the reload completes.
//
// The autofill content script (loaded on AWS Security Agent create pages)
// sends an `AUTOFILL_ACCEPTED` message when the user clicks a suggestion;
// the worker adds the URL to `filledUrls` and broadcasts a
// `FILLED_UPDATED` message to all matching tabs so their panels re-render
// the checkmark immediately.

import { browser } from '../shared/browser.js';
import {
    loadState,
    loadSession,
    saveState,
    saveList,
    clearList,
    saveSessionTabId,
    saveTargetDomain,
    loadFilledUrls,
    saveFilledUrls,
    loadExcludedUrls,
    saveExcludedUrls
} from './storage.js';
import { recordRequest } from './recorder.js';
import { extractOrigin } from '../shared/domain.js';
import { STORAGE_KEYS } from '../shared/constants.js';
import {
    RecordingState,
    setState,
    canStart,
    canStop,
    nextStateForStart,
    nextStateForStop
} from './state.js';

// ---------------------------------------------------------------------------
// Module-level configuration
// ---------------------------------------------------------------------------

const URL_FILTER = Object.freeze({ urls: ['http://*/*', 'https://*/*'] });

const RECORDING_BADGE_TEXT = 'REC';
const RECORDING_BADGE_COLOR = '#7c3aed';
const EMPTY_BADGE_TEXT = '';

const DEFAULT_ICON_PATHS = Object.freeze({
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png'
});

const BORDER_SCRIPT_FILE = 'content/recording-border.js';
const SECURITY_AGENT_URL_FILTER = 'https://*.securityagent.global.app.aws/*';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {'idle' | 'recording' | 'stopped'} */
let cachedState = RecordingState.Idle;

/** @type {string[]} */
let cachedList = [];

/** @type {number | null} */
let cachedSessionTabId = null;

/** @type {string | null} */
let cachedTargetDomain = null;

/** @type {string[]} */
let cachedFilledUrls = [];

/** @type {string[]} */
let cachedExcludedUrls = [];

let bootstrapped = false;
let bootstrapPromise = null;
let listenersRegistered = false;

// ---------------------------------------------------------------------------
// Diagnostics helper
// ---------------------------------------------------------------------------

export async function safeApiCall(apiName, fn) {
    try {
        return await fn();
    } catch (err) {
        const ua =
            typeof navigator !== 'undefined' && navigator.userAgent
                ? navigator.userAgent
                : 'unknown';
        // eslint-disable-next-line no-console
        console.warn(
            `[domain-recorder] Unsupported or failing API: ${apiName} on ` +
            `${ua}. Continuing without this feature. Error: ${err}`
        );
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function ensureBootstrapped() {
    if (bootstrapped) return;
    if (!bootstrapPromise) {
        bootstrapPromise = (async () => {
            const { state, list } = await loadState();
            const session = await loadSession();
            const filled = await loadFilledUrls();
            const excluded = await loadExcludedUrls();
            cachedState = state;
            cachedList = list;
            cachedSessionTabId = session.sessionTabId;
            cachedTargetDomain = session.targetDomain;
            cachedFilledUrls = filled;
            cachedExcludedUrls = excluded;

            if (state !== RecordingState.Recording) {
                if (cachedSessionTabId !== null) {
                    await saveSessionTabId(null);
                    cachedSessionTabId = null;
                }
            }

            bootstrapped = true;
            await applyActionForState(cachedState);
        })().catch((err) => {
            bootstrapPromise = null;
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] bootstrap failed: ${err}`);
        });
    }
    await bootstrapPromise;
}

// ---------------------------------------------------------------------------
// Toolbar action
// ---------------------------------------------------------------------------

async function applyActionForState(state) {
    if (!browser.action || typeof browser.action.setBadgeText !== 'function') {
        return;
    }
    if (state === RecordingState.Recording) {
        await safeApiCall('action.setBadgeText', () =>
            browser.action.setBadgeText({ text: RECORDING_BADGE_TEXT })
        );
        await safeApiCall('action.setBadgeBackgroundColor', () =>
            browser.action.setBadgeBackgroundColor({
                color: RECORDING_BADGE_COLOR
            })
        );
        await safeApiCall('action.setIcon', () =>
            browser.action.setIcon({ path: { ...DEFAULT_ICON_PATHS } })
        );
    } else {
        await safeApiCall('action.setBadgeText', () =>
            browser.action.setBadgeText({ text: EMPTY_BADGE_TEXT })
        );
        await safeApiCall('action.setIcon', () =>
            browser.action.setIcon({ path: { ...DEFAULT_ICON_PATHS } })
        );
    }
}

// ---------------------------------------------------------------------------
// webRequest handler
// ---------------------------------------------------------------------------

export async function handleWebRequest(details) {
    await ensureBootstrapped();
    if (cachedState !== RecordingState.Recording) {
        return;
    }
    if (!details || typeof details.url !== 'string') {
        return;
    }
    if (
        cachedSessionTabId === null ||
        typeof details.tabId !== 'number' ||
        details.tabId !== cachedSessionTabId
    ) {
        return;
    }
    const requestOrigin = extractOrigin(details.url);
    if (
        requestOrigin !== null &&
        cachedTargetDomain !== null &&
        sameHost(requestOrigin, cachedTargetDomain)
    ) {
        return;
    }

    const result = recordRequest(details.url, cachedList);
    if (!result.changed) return;
    const persisted = await saveList(result.list);
    if (persisted.ok) {
        cachedList = result.list;
    }
}

function sameHost(originA, originB) {
    const a = originA.split('://')[1];
    const b = originB.split('://')[1];
    return a !== undefined && a === b;
}

// ---------------------------------------------------------------------------
// Recording border injection
// ---------------------------------------------------------------------------

async function showBorder(tabId) {
    if (
        !browser.scripting ||
        typeof browser.scripting.executeScript !== 'function'
    ) {
        return;
    }
    await safeApiCall('scripting.executeScript', () =>
        browser.scripting.executeScript({
            target: { tabId },
            files: [BORDER_SCRIPT_FILE]
        })
    );
}

async function hideBorder(tabId) {
    if (
        !browser.tabs ||
        typeof browser.tabs.sendMessage !== 'function' ||
        typeof tabId !== 'number'
    ) {
        return;
    }
    await safeApiCall('tabs.sendMessage(BORDER_HIDE)', () =>
        browser.tabs.sendMessage(tabId, { type: 'BORDER_HIDE' })
    );
}

async function handleTabUpdated(tabId, changeInfo) {
    if (cachedState !== RecordingState.Recording) return;
    if (cachedSessionTabId === null || tabId !== cachedSessionTabId) return;
    if (changeInfo && changeInfo.status === 'complete') {
        await showBorder(tabId);
    }
}

// ---------------------------------------------------------------------------
// Autofill broadcast
// ---------------------------------------------------------------------------

async function broadcastFilledUpdate() {
    if (
        !browser.tabs ||
        typeof browser.tabs.query !== 'function' ||
        typeof browser.tabs.sendMessage !== 'function'
    ) {
        return;
    }
    try {
        const tabs = await browser.tabs.query({
            url: SECURITY_AGENT_URL_FILTER
        });
        const filled = cachedFilledUrls.slice();
        const excluded = cachedExcludedUrls.slice();
        for (const t of tabs) {
            if (typeof t.id === 'number') {
                browser.tabs
                    .sendMessage(t.id, {
                        type: 'FILLED_UPDATED',
                        filled,
                        excluded
                    })
                    .catch(() => { });
            }
        }
    } catch {
        // Best-effort.
    }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleGetStatus() {
    await ensureBootstrapped();
    return {
        ok: true,
        state: cachedState,
        count: cachedList.length,
        list: cachedList.slice(),
        targetDomain: cachedTargetDomain,
        sessionTabId: cachedSessionTabId,
        filled: cachedFilledUrls.slice(),
        excluded: cachedExcludedUrls.slice()
    };
}

async function getActiveTab() {
    if (!browser.tabs || typeof browser.tabs.query !== 'function') return null;
    try {
        const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true
        });
        return tabs && tabs[0] ? tabs[0] : null;
    } catch {
        return null;
    }
}

async function handleStartRecording() {
    await ensureBootstrapped();
    if (!canStart(cachedState)) {
        return {
            ok: true,
            state: cachedState,
            count: cachedList.length,
            list: cachedList.slice(),
            targetDomain: cachedTargetDomain,
            sessionTabId: cachedSessionTabId,
            filled: cachedFilledUrls.slice(),
            excluded: cachedExcludedUrls.slice()
        };
    }

    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== 'number') {
        return { ok: false, error: 'no-active-tab' };
    }
    const targetOrigin =
        typeof tab.url === 'string' ? extractOrigin(tab.url) : null;
    if (!targetOrigin) {
        return {
            ok: false,
            error: 'active-tab-not-recordable',
            message:
                'Open the http(s) page you want to record before starting.'
        };
    }

    await saveSessionTabId(tab.id);
    cachedSessionTabId = tab.id;
    await saveTargetDomain(targetOrigin);
    cachedTargetDomain = targetOrigin;

    await saveList([]);
    cachedList = [];
    await saveFilledUrls([]);
    cachedFilledUrls = [];
    await saveExcludedUrls([]);
    cachedExcludedUrls = [];

    const next = nextStateForStart(cachedState);
    const result = await setState(next, { saveState });
    if (!result.ok) {
        await saveSessionTabId(null);
        cachedSessionTabId = null;
        await saveTargetDomain(null);
        cachedTargetDomain = null;
        return {
            ok: false,
            state: cachedState,
            error: result.error ? String(result.error) : 'persist-failed'
        };
    }
    cachedState = result.state;

    if (browser.tabs && typeof browser.tabs.reload === 'function') {
        await safeApiCall('tabs.reload', () => browser.tabs.reload(tab.id));
    } else {
        await showBorder(tab.id);
    }

    await applyActionForState(cachedState);
    broadcastFilledUpdate();
    return {
        ok: true,
        state: cachedState,
        count: cachedList.length,
        list: cachedList.slice(),
        targetDomain: cachedTargetDomain,
        sessionTabId: cachedSessionTabId,
        filled: cachedFilledUrls.slice(),
        excluded: cachedExcludedUrls.slice()
    };
}

async function handleStopRecording() {
    await ensureBootstrapped();
    if (!canStop(cachedState)) {
        return {
            ok: true,
            state: cachedState,
            count: cachedList.length,
            list: cachedList.slice(),
            targetDomain: cachedTargetDomain,
            filled: cachedFilledUrls.slice(),
            excluded: cachedExcludedUrls.slice()
        };
    }

    const tabIdToClean = cachedSessionTabId;
    const next = nextStateForStop(cachedState);
    const result = await setState(next, { saveState });
    if (!result.ok) {
        return {
            ok: false,
            state: cachedState,
            error: result.error ? String(result.error) : 'persist-failed'
        };
    }
    cachedState = result.state;

    await saveSessionTabId(null);
    cachedSessionTabId = null;

    if (tabIdToClean !== null) {
        await hideBorder(tabIdToClean);
    }

    await applyActionForState(cachedState);
    return {
        ok: true,
        state: cachedState,
        count: cachedList.length,
        list: cachedList.slice(),
        targetDomain: cachedTargetDomain,
        filled: cachedFilledUrls.slice(),
        excluded: cachedExcludedUrls.slice()
    };
}

async function handleClearDomains() {
    await ensureBootstrapped();
    const result = await clearList();
    if (result.ok) {
        cachedList = [];
        await saveTargetDomain(null);
        cachedTargetDomain = null;
        await saveFilledUrls([]);
        cachedFilledUrls = [];
        await saveExcludedUrls([]);
        cachedExcludedUrls = [];
        broadcastFilledUpdate();
        return { ok: true };
    }
    return {
        ok: false,
        error: result.error ? String(result.error) : 'persist-failed'
    };
}

async function handleAutofillAccepted(url) {
    await ensureBootstrapped();
    if (typeof url !== 'string' || url.length === 0) {
        return { ok: false, filled: cachedFilledUrls.slice() };
    }
    if (!cachedFilledUrls.includes(url)) {
        const next = [...cachedFilledUrls, url];
        const persisted = await saveFilledUrls(next);
        if (persisted.ok) {
            cachedFilledUrls = next;
        }
    }
    broadcastFilledUpdate();
    return { ok: true, filled: cachedFilledUrls.slice() };
}

async function handleExcludedAccepted(url) {
    await ensureBootstrapped();
    if (typeof url !== 'string' || url.length === 0) {
        return { ok: false, excluded: cachedExcludedUrls.slice() };
    }
    if (!cachedExcludedUrls.includes(url)) {
        const next = [...cachedExcludedUrls, url];
        const persisted = await saveExcludedUrls(next);
        if (persisted.ok) {
            cachedExcludedUrls = next;
        }
    }
    broadcastFilledUpdate();
    return { ok: true, excluded: cachedExcludedUrls.slice() };
}

export function handleMessage(message) {
    if (!message || typeof message !== 'object') {
        return Promise.resolve({ ok: false, error: 'invalid-message' });
    }
    switch (message.type) {
        case 'GET_STATUS':
            return handleGetStatus();
        case 'START_RECORDING':
            return handleStartRecording();
        case 'STOP_RECORDING':
            return handleStopRecording();
        case 'CLEAR_DOMAINS':
            return handleClearDomains();
        case 'AUTOFILL_ACCEPTED':
            return handleAutofillAccepted(message.url);
        case 'EXCLUDED_ACCEPTED':
            return handleExcludedAccepted(message.url);
        default:
            return Promise.resolve({
                ok: false,
                error: `unknown-message: ${message.type}`
            });
    }
}

// ---------------------------------------------------------------------------
// storage.onChanged handler
// ---------------------------------------------------------------------------

export function handleStorageChange(changes, areaName) {
    if (areaName !== 'local' || !changes) return;

    if (
        Object.prototype.hasOwnProperty.call(
            changes,
            STORAGE_KEYS.recordingState
        )
    ) {
        const next = changes[STORAGE_KEYS.recordingState].newValue;
        if (
            next === RecordingState.Idle ||
            next === RecordingState.Recording ||
            next === RecordingState.Stopped
        ) {
            cachedState = next;
            applyActionForState(cachedState);
        } else if (next === undefined) {
            cachedState = RecordingState.Idle;
            applyActionForState(cachedState);
        }
    }

    if (
        Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.domainList)
    ) {
        const next = changes[STORAGE_KEYS.domainList].newValue;
        if (Array.isArray(next)) {
            cachedList = next;
        } else if (next === undefined) {
            cachedList = [];
        }
    }

    if (
        Object.prototype.hasOwnProperty.call(
            changes,
            STORAGE_KEYS.sessionTabId
        )
    ) {
        const next = changes[STORAGE_KEYS.sessionTabId].newValue;
        cachedSessionTabId =
            typeof next === 'number' && Number.isInteger(next) ? next : null;
    }

    if (
        Object.prototype.hasOwnProperty.call(
            changes,
            STORAGE_KEYS.targetDomain
        )
    ) {
        const next = changes[STORAGE_KEYS.targetDomain].newValue;
        cachedTargetDomain = typeof next === 'string' ? next : null;
    }

    if (
        Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.filledUrls)
    ) {
        const next = changes[STORAGE_KEYS.filledUrls].newValue;
        cachedFilledUrls = Array.isArray(next) ? next : [];
    }

    if (
        Object.prototype.hasOwnProperty.call(
            changes,
            STORAGE_KEYS.excludedUrls
        )
    ) {
        const next = changes[STORAGE_KEYS.excludedUrls].newValue;
        cachedExcludedUrls = Array.isArray(next) ? next : [];
    }
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

async function handleTabRemoved(tabId) {
    if (cachedSessionTabId !== null && tabId === cachedSessionTabId) {
        cachedSessionTabId = null;
        await saveSessionTabId(null);
        if (cachedState === RecordingState.Recording) {
            const next = nextStateForStop(cachedState);
            const result = await setState(next, { saveState });
            if (result.ok) {
                cachedState = result.state;
                await applyActionForState(cachedState);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Top-level listener registration
// ---------------------------------------------------------------------------

export function registerListeners() {
    if (listenersRegistered) return;
    listenersRegistered = true;

    if (browser.runtime && browser.runtime.onStartup) {
        try {
            browser.runtime.onStartup.addListener(() => {
                ensureBootstrapped();
            });
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] runtime.onStartup register failed: ${err}`);
        }
    }

    if (browser.runtime && browser.runtime.onInstalled) {
        try {
            browser.runtime.onInstalled.addListener(() => {
                ensureBootstrapped();
            });
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] runtime.onInstalled register failed: ${err}`);
        }
    }

    if (browser.runtime && browser.runtime.onMessage) {
        try {
            browser.runtime.onMessage.addListener((message) =>
                handleMessage(message)
            );
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] runtime.onMessage register failed: ${err}`);
        }
    }

    if (browser.storage && browser.storage.onChanged) {
        try {
            browser.storage.onChanged.addListener(handleStorageChange);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] storage.onChanged register failed: ${err}`);
        }
    }

    if (browser.webRequest && browser.webRequest.onBeforeRequest) {
        try {
            browser.webRequest.onBeforeRequest.addListener(
                handleWebRequest,
                URL_FILTER
            );
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] webRequest.onBeforeRequest register failed: ${err}`);
        }
    }

    if (browser.tabs && browser.tabs.onRemoved) {
        try {
            browser.tabs.onRemoved.addListener(handleTabRemoved);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] tabs.onRemoved register failed: ${err}`);
        }
    }

    if (browser.tabs && browser.tabs.onUpdated) {
        try {
            browser.tabs.onUpdated.addListener(handleTabUpdated);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[domain-recorder] tabs.onUpdated register failed: ${err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Module side effects
// ---------------------------------------------------------------------------

registerListeners();
ensureBootstrapped();

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
    getCachedState: () => cachedState,
    getCachedList: () => cachedList.slice(),
    getCachedSessionTabId: () => cachedSessionTabId,
    getCachedTargetDomain: () => cachedTargetDomain,
    getCachedFilledUrls: () => cachedFilledUrls.slice(),
    getCachedExcludedUrls: () => cachedExcludedUrls.slice(),
    isBootstrapped: () => bootstrapped,
    listenersRegistered: () => listenersRegistered,
    resetForTests: () => {
        cachedState = RecordingState.Idle;
        cachedList = [];
        cachedSessionTabId = null;
        cachedTargetDomain = null;
        cachedFilledUrls = [];
        cachedExcludedUrls = [];
        bootstrapped = false;
        bootstrapPromise = null;
        listenersRegistered = false;
    }
};
