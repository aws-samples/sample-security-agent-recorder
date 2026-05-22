// Popup renderer for the AWS Security Agent Recorder.
//
// On open, the popup queries the background for current status and renders:
//   - the target domain captured at session start
//   - the inline list of "accessible URLs" (every other domain contacted)
//   - the controls relevant to the current state
//
// The popup updates dynamically via `browser.storage.onChanged` so the list
// grows as the user interacts with their target page.

import { browser } from '../shared/browser.js';
import { STORAGE_KEYS, compareCi } from '../shared/constants.js';

const VALID_STATES = Object.freeze(['idle', 'recording', 'stopped']);

const CONFIRM_CLEAR_MESSAGE =
    'Clear the captured domain list? This cannot be undone.';

function normalizeState(value) {
    return VALID_STATES.includes(value) ? value : 'idle';
}

function setStatus(text, tone) {
    const el = document.getElementById('status-banner');
    if (!el) return;
    el.textContent = text;
    if (!text) {
        el.removeAttribute('data-tone');
        return;
    }
    el.setAttribute('data-tone', tone || 'info');
}

function renderList(domains, filled, excluded) {
    const listEl = document.getElementById('urls-list');
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    const filledSet = filled instanceof Set ? filled : new Set();
    const excludedSet = excluded instanceof Set ? excluded : new Set();
    for (const domain of domains) {
        const li = document.createElement('li');
        li.textContent = domain;
        li.setAttribute('role', 'button');
        li.setAttribute('tabindex', '0');
        li.setAttribute('title', 'Click to copy');
        li.dataset.copyText = domain;
        const isFilled = filledSet.has(domain);
        const isExcluded = excludedSet.has(domain);
        li.setAttribute(
            'data-filled',
            isFilled ? 'true' : 'false'
        );
        li.setAttribute(
            'data-excluded',
            isExcluded ? 'true' : 'false'
        );
        if (isFilled) {
            const tick = document.createElement('span');
            tick.textContent = ' \u2713';
            tick.style.color = '#16a34a';
            tick.style.fontWeight = '700';
            tick.style.marginLeft = '6px';
            tick.title = 'Added as Accessible URL';
            li.appendChild(tick);
        }
        if (isExcluded) {
            const x = document.createElement('span');
            x.textContent = ' \u2717';
            x.style.color = '#dc2626';
            x.style.fontWeight = '700';
            x.style.marginLeft = '6px';
            x.title = 'Added as Out-of-scope URL';
            li.appendChild(x);
        }
        listEl.appendChild(li);
    }
}

function applyModel(model) {
    const root = document.getElementById('popup-root');
    if (!root) return;

    const state = normalizeState(model.state);
    const list = Array.isArray(model.list) ? model.list.slice() : [];
    list.sort(compareCi);
    const filled = new Set(
        Array.isArray(model.filled) ? model.filled : []
    );
    const excluded = new Set(
        Array.isArray(model.excluded) ? model.excluded : []
    );
    const isEmpty = list.length === 0;

    root.setAttribute('data-state', state);
    root.setAttribute('data-empty', isEmpty ? 'true' : 'false');
    root.setAttribute('data-error', model.error ? 'true' : 'false');
    root.setAttribute(
        'data-target-known',
        model.targetDomain ? 'true' : 'false'
    );

    const target = document.getElementById('target-domain');
    if (target) {
        const domain = model.targetDomain || '-';
        target.textContent = domain;
        if (model.targetDomain) {
            target.dataset.copyText = model.targetDomain;
        } else {
            delete target.dataset.copyText;
        }
        if (model.targetDomain && filled.has(model.targetDomain)) {
            const tick = document.createElement('span');
            tick.textContent = ' \u2713';
            tick.style.color = '#16a34a';
            tick.style.fontWeight = '700';
            tick.title = 'Filled into the form';
            target.appendChild(tick);
        }
    }

    const count = document.getElementById('count');
    if (count) count.textContent = String(list.length);

    renderList(list, filled, excluded);

    const errorEl = document.getElementById('error-banner');
    if (errorEl) {
        if (model.error) {
            errorEl.hidden = false;
            errorEl.textContent = model.error;
        } else {
            errorEl.hidden = true;
            errorEl.textContent = '';
        }
    }
}

async function refreshStatus() {
    let response;
    try {
        response = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
    } catch (err) {
        applyModel({
            state: 'idle',
            list: [],
            targetDomain: null,
            error: `Could not load status: ${err}`
        });
        return;
    }
    if (!response || response.ok === false) {
        applyModel({
            state: 'idle',
            list: [],
            targetDomain: null,
            error:
                (response && typeof response.error === 'string'
                    ? response.error
                    : null) || 'Could not load status.'
        });
        return;
    }
    applyModel({
        state: response.state,
        list: response.list || [],
        targetDomain: response.targetDomain || null,
        filled: response.filled || [],
        excluded: response.excluded || [],
        error: null
    });
}

async function handleStart() {
    setStatus('', 'info');
    try {
        const r = await browser.runtime.sendMessage({
            type: 'START_RECORDING'
        });
        if (r && r.ok === false) {
            const message =
                (r.message && String(r.message)) ||
                (r.error && String(r.error)) ||
                'Could not start recording.';
            setStatus(message, 'error');
            return;
        }
    } catch (err) {
        setStatus(`Could not start: ${err}`, 'error');
        return;
    }
    await refreshStatus();
    setStatus('Recording. Use the page normally.', 'info');
}

async function handleStop() {
    try {
        await browser.runtime.sendMessage({ type: 'STOP_RECORDING' });
    } catch (err) {
        setStatus(`Could not stop: ${err}`, 'error');
        return;
    }
    await refreshStatus();
    setStatus('Stopped. Copy or clear the list when ready.', 'info');
}

async function handleCopy() {
    const items = Array.from(
        document.querySelectorAll('#urls-list li')
    ).map((li) => li.dataset.copyText || li.textContent || '');
    if (items.length === 0) {
        setStatus('No domains to copy.', 'info');
        return;
    }
    try {
        await navigator.clipboard.writeText(items.join('\n'));
        const noun = items.length === 1 ? 'domain' : 'domains';
        setStatus(`Copied ${items.length} ${noun}.`, 'success');
    } catch (err) {
        setStatus(`Could not copy: ${err}`, 'error');
    }
}

async function handleClear() {
    const confirmed =
        typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(CONFIRM_CLEAR_MESSAGE)
            : false;
    if (!confirmed) return;
    try {
        await browser.runtime.sendMessage({ type: 'CLEAR_DOMAINS' });
    } catch (err) {
        setStatus(`Could not clear: ${err}`, 'error');
        return;
    }
    await refreshStatus();
    setStatus('Cleared.', 'info');
}

function attachHandlers() {
    const startButton = document.getElementById('start-button');
    const stopButton = document.getElementById('stop-button');
    const copyButton = document.getElementById('copy-button');
    const clearButton = document.getElementById('clear-button');
    if (startButton) startButton.addEventListener('click', handleStart);
    if (stopButton) stopButton.addEventListener('click', handleStop);
    if (copyButton) copyButton.addEventListener('click', handleCopy);
    if (clearButton) clearButton.addEventListener('click', handleClear);

    // Click-to-copy on individual URL list items. Use event delegation so
    // a single listener covers items added later via re-render.
    const listEl = document.getElementById('urls-list');
    if (listEl) {
        listEl.addEventListener('click', (event) => {
            const item = event.target.closest('li');
            if (item && listEl.contains(item)) {
                copyText(
                    item.dataset.copyText || item.textContent || ''
                );
            }
        });
        listEl.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const item = event.target.closest('li');
            if (item && listEl.contains(item)) {
                event.preventDefault();
                copyText(
                    item.dataset.copyText || item.textContent || ''
                );
            }
        });
    }

    // Click-to-copy on the target domain card.
    const targetEl = document.getElementById('target-domain');
    if (targetEl) {
        targetEl.addEventListener('click', () => {
            const text =
                targetEl.dataset.copyText ||
                (targetEl.textContent || '').trim();
            if (text && text !== '-') copyText(text);
        });
    }
}

async function copyText(text) {
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        setStatus(`Copied: ${text}`, 'success');
    } catch (err) {
        setStatus(`Could not copy: ${err}`, 'error');
    }
}

function subscribeToStorage() {
    if (
        !browser.storage ||
        !browser.storage.onChanged ||
        typeof browser.storage.onChanged.addListener !== 'function'
    ) {
        return;
    }
    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes) return;
        // Only re-render if a key we care about changed.
        const watched = [
            STORAGE_KEYS.recordingState,
            STORAGE_KEYS.domainList,
            STORAGE_KEYS.targetDomain,
            STORAGE_KEYS.filledUrls,
            STORAGE_KEYS.excludedUrls
        ];
        const touched = watched.some((k) =>
            Object.prototype.hasOwnProperty.call(changes, k)
        );
        if (!touched) return;
        refreshStatus();
    });
}

async function init() {
    attachHandlers();
    subscribeToStorage();
    await refreshStatus();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init();
        });
    } else {
        init();
    }
}
