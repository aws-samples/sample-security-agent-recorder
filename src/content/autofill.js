// Autofill content script for the AWS Security Agent create form.
//
// Runs on https://*.securityagent.global.app.aws/* and only activates when
// the page URL matches `app-*.securityagent.global.app.aws/as-*/create`.
//
// AWS Security Agent uses Cloudscape, which renders inputs with
// `aria-labelledby` pointing to a separate label element rendered later
// in the React tree. Because the label text may not be in the DOM at
// document_idle, we:
//   1. Resolve labels on demand (every focus event re-resolves).
//   2. Retry briefly with a tiny polling loop when the labelled element
//      isn't yet present.
//   3. Fall back to a positional heuristic when label text is missing or
//      doesn't match: the first matching input on the page is the target;
//      subsequent inputs that share the same placeholder pattern are the
//      accessible-URL fields.
//
// Suggestions are shown in a panel anchored to the focused field. Clicking
// a suggestion fills the field via the React-compatible native setter and
// notifies the background to mark the URL as "filled".

(() => {
    if (window.__awsSecurityAgentAutofillLoaded) return;
    window.__awsSecurityAgentAutofillLoaded = true;

    const HOST_PATTERN = /^app-[^.]+\.securityagent\.global\.app\.aws$/i;
    const PATH_PATTERN = /^\/as-[^/]+\/create(?:\/|$)/i;

    /**
     * True when the current URL matches the AWS Security Agent create page.
     * This is a function rather than a captured constant because the host
     * is a single-page app: the path changes via client-side routing
     * without firing a full page load, so our gate has to be re-evaluated
     * whenever the URL changes.
     */
    function isOnCreatePage() {
        return (
            HOST_PATTERN.test(location.hostname) &&
            PATH_PATTERN.test(location.pathname)
        );
    }

    const PANEL_ID = 'aws-security-agent-autofill-panel';
    const TARGET_KEYWORDS = [
        'target url',
        'target urls',
        'target uri',
        'target endpoint',
        'application url',
        'app url'
    ];
    const ACCESSIBLE_KEYWORDS = [
        'accessible url',
        'accessible urls',
        'accessible uri',
        'accessible domain',
        'accessible host',
        'allowed url',
        'allowed domain',
        'additional url',
        'allow list'
    ];
    // The "Out-of-scope URLs" exclude list. We DO offer suggestions here
    // (the user may want to exclude one of the recorded URLs from testing),
    // but we mark accepted entries with ✗ instead of ✓.
    const EXCLUDED_KEYWORDS = [
        'out-of-scope',
        'out of scope',
        'exclude',
        'denied'
    ];
    // The form uses URL-shaped placeholders on every URL input. We use this
    // as a candidate filter — but classification ultimately depends on the
    // section label, not the placeholder.
    const URL_PLACEHOLDER_RE = /https?:\/\//i;

    let cachedSnapshot = {
        targetDomain: null,
        list: [],
        filled: [],
        excluded: []
    };
    let activeField = null;
    let activeKind = null;
    let panel = null;

    function safeText(node) {
        return ((node && node.textContent) || '').trim().toLowerCase();
    }

    function readLabelTextNow(input) {
        const aria = input.getAttribute('aria-label');
        if (aria && aria.trim()) {
            return { sectionText: '', allText: aria.trim().toLowerCase() };
        }
        const labelledBy = input.getAttribute('aria-labelledby');
        if (labelledBy) {
            const ids = labelledBy.split(/\s+/).filter(Boolean);
            const texts = ids
                .map((id) => safeText(document.getElementById(id)))
                .filter(Boolean);
            const sectionText = texts.length > 0 ? texts[0] : '';
            const allText = texts.join(' ');
            if (allText) return { sectionText, allText };
        }
        if (input.id) {
            const lbl = document.querySelector(
                `label[for="${CSS.escape(input.id)}"]`
            );
            if (lbl) {
                const t = safeText(lbl);
                if (t) return { sectionText: '', allText: t };
            }
        }
        const wrapping = input.closest('label');
        if (wrapping) {
            const t = safeText(wrapping);
            if (t) return { sectionText: '', allText: t };
        }
        // Cloudscape pattern: walk up to the outer formField group and read
        // its label. The outer label carries the section heading
        // ("Target URLs", "Out-of-scope URLs", "Accessible URLs"), which is
        // what we actually want to classify on.
        const outerGroup = input.closest('[data-analytics-field-label]');
        if (outerGroup) {
            const ref = outerGroup.getAttribute(
                'data-analytics-field-label'
            );
            // ref looks like: [id="formField:r30:-label"]
            const m = ref && ref.match(/id="([^"]+)"/);
            if (m && m[1]) {
                const lbl = document.getElementById(m[1]);
                const t = safeText(lbl);
                if (t) return { sectionText: t, allText: t };
            }
        }
        return { sectionText: '', allText: '' };
    }

    /**
     * Resolve label text with a brief retry. Cloudscape sometimes mounts
     * the labelled element a tick after the input renders.
     *
     * @param {HTMLElement} input
     * @returns {Promise<{ sectionText: string, allText: string }>}
     */
    function readLabelText(input) {
        return new Promise((resolve) => {
            const immediate = readLabelTextNow(input);
            if (immediate.allText) {
                resolve(immediate);
                return;
            }
            let tries = 0;
            const id = setInterval(() => {
                tries += 1;
                const result = readLabelTextNow(input);
                if (result.allText || tries >= 6) {
                    clearInterval(id);
                    resolve(result);
                }
            }, 50);
        });
    }

    function isUrlInput(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        if (el.disabled || el.readOnly) return false;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag !== 'INPUT') return false;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return ['text', 'url', 'search', 'email', ''].includes(type);
    }

    function looksLikeUrlField(el) {
        if (!isUrlInput(el)) return false;
        const placeholder = el.getAttribute('placeholder') || '';
        return URL_PLACEHOLDER_RE.test(placeholder);
    }

    /**
     * Classify a focused input based on its outer form-field section
     * label. Returns 'target', 'accessible', 'excluded', or null.
     *
     * @param {HTMLElement} input
     * @returns {Promise<'target' | 'accessible' | 'excluded' | null>}
     */
    async function classifyField(input) {
        if (!isUrlInput(input)) return null;
        if (!looksLikeUrlField(input)) return null;
        const { sectionText, allText } = await readLabelText(input);
        const haystack = (sectionText || allText || '').toLowerCase();
        if (!haystack) return null;
        // Out-of-scope wins over the other matchers because some labels
        // could otherwise also match "url".
        for (const kw of EXCLUDED_KEYWORDS) {
            if (haystack.includes(kw)) return 'excluded';
        }
        for (const kw of TARGET_KEYWORDS) {
            if (haystack.includes(kw)) return 'target';
        }
        for (const kw of ACCESSIBLE_KEYWORDS) {
            if (haystack.includes(kw)) return 'accessible';
        }
        return null;
    }

    function setNativeValue(el, value) {
        const proto =
            el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function ensurePanel() {
        if (panel && document.body.contains(panel)) return panel;
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.setAttribute('role', 'listbox');
        panel.setAttribute('aria-label', 'Recorded suggestions');
        Object.assign(panel.style, {
            position: 'absolute',
            zIndex: '2147483647',
            background: '#ffffff',
            border: '1px solid #c7d2fe',
            borderRadius: '6px',
            boxShadow: '0 8px 24px rgba(15, 23, 42, 0.15)',
            padding: '4px',
            minWidth: '240px',
            maxWidth: '460px',
            maxHeight: '260px',
            overflowY: 'auto',
            font:
                '12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
            color: '#1e293b'
        });
        // Don't lose focus on the input when interacting with the panel.
        panel.addEventListener('mousedown', (e) => e.preventDefault());
        document.body.appendChild(panel);
        return panel;
    }

    function destroyPanel() {
        if (panel && panel.parentNode) {
            panel.parentNode.removeChild(panel);
        }
        panel = null;
    }

    function positionPanel(field) {
        if (!panel) return;
        const rect = field.getBoundingClientRect();
        panel.style.top = `${window.scrollY + rect.bottom + 4}px`;
        panel.style.left = `${window.scrollX + rect.left}px`;
        panel.style.minWidth = `${Math.max(rect.width, 240)}px`;
    }

    function buildSuggestionRow(text, marker, onAccept) {
        const row = document.createElement('div');
        row.setAttribute('role', 'option');
        row.setAttribute('tabindex', '0');
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            borderRadius: '4px',
            cursor: 'pointer',
            userSelect: 'none'
        });
        row.addEventListener('mouseenter', () => {
            row.style.background = '#ede9fe';
        });
        row.addEventListener('mouseleave', () => {
            row.style.background = 'transparent';
        });
        const status = document.createElement('span');
        // marker can be 'filled' (✓ green), 'excluded' (✗ red),
        // 'both' (✓✗), or 'none' (+ purple).
        let glyph = '+';
        let color = '#7c3aed';
        if (marker === 'filled') {
            glyph = '✓';
            color = '#16a34a';
        } else if (marker === 'excluded') {
            glyph = '✗';
            color = '#dc2626';
        } else if (marker === 'both') {
            glyph = '✓✗';
            color = '#7c3aed';
        }
        status.textContent = glyph;
        Object.assign(status.style, {
            display: 'inline-block',
            width: '24px',
            color,
            fontWeight: '700',
            textAlign: 'center'
        });
        const value = document.createElement('span');
        value.textContent = text;
        Object.assign(value.style, {
            flex: '1',
            wordBreak: 'break-all'
        });
        row.appendChild(status);
        row.appendChild(value);
        row.addEventListener('click', () => onAccept(text));
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onAccept(text);
            }
        });
        return row;
    }

    function buildHeader(text) {
        const h = document.createElement('div');
        h.textContent = text;
        Object.assign(h.style, {
            padding: '6px 10px 4px',
            color: '#4338ca',
            fontWeight: '700',
            fontSize: '11px',
            letterSpacing: '0.04em',
            textTransform: 'uppercase'
        });
        return h;
    }

    function buildEmptyMessage(text) {
        const p = document.createElement('div');
        p.textContent = text;
        Object.assign(p.style, {
            padding: '10px',
            color: '#64748b',
            fontStyle: 'italic'
        });
        return p;
    }

    function markerFor(url, kind) {
        const filled = (cachedSnapshot.filled || []).includes(url);
        const excluded = (cachedSnapshot.excluded || []).includes(url);
        if (filled && excluded) return 'both';
        if (kind === 'excluded') {
            // In the out-of-scope panel: ✗ wins; ✓ alone is shown so the
            // user can see this one is already in the accessible list.
            if (excluded) return 'excluded';
            if (filled) return 'filled';
            return 'none';
        }
        // accessible / target panels: ✓ wins; ✗ alone is shown so the user
        // is reminded this URL is already excluded.
        if (filled) return 'filled';
        if (excluded) return 'excluded';
        return 'none';
    }

    function renderPanel() {
        if (!panel || !activeField) return;
        while (panel.firstChild) panel.removeChild(panel.firstChild);

        if (activeKind === 'target') {
            panel.appendChild(buildHeader('Recorded target URL'));
            if (cachedSnapshot.targetDomain) {
                panel.appendChild(
                    buildSuggestionRow(
                        cachedSnapshot.targetDomain,
                        markerFor(cachedSnapshot.targetDomain, 'target'),
                        (v) => acceptSuggestion(v, 'target')
                    )
                );
            } else {
                panel.appendChild(
                    buildEmptyMessage(
                        'No recording yet. Use the extension popup to record.'
                    )
                );
            }

            // Secondary section: accessible URLs offered as alternate
            // candidates for the target field. Useful when the user wants
            // a different URL from the recorded set as the target. Filter
            // out the recorded target itself to avoid duplicating it.
            const list = (cachedSnapshot.list || []).filter(
                (url) => url !== cachedSnapshot.targetDomain
            );
            if (list.length > 0) {
                panel.appendChild(
                    buildHeader('Or pick from recorded URLs')
                );
                for (const url of list) {
                    panel.appendChild(
                        buildSuggestionRow(
                            url,
                            markerFor(url, 'target'),
                            (v) => acceptSuggestion(v, 'target')
                        )
                    );
                }
            }
            return;
        }

        if (activeKind === 'accessible' || activeKind === 'excluded') {
            const headerText =
                activeKind === 'excluded'
                    ? 'Exclude a recorded URL'
                    : 'Recorded accessible URLs';
            panel.appendChild(buildHeader(headerText));
            const list = cachedSnapshot.list || [];
            if (list.length === 0) {
                panel.appendChild(
                    buildEmptyMessage(
                        activeKind === 'excluded'
                            ? 'No recorded URLs to exclude.'
                            : 'No accessible URLs recorded.'
                    )
                );
                return;
            }
            for (const url of list) {
                panel.appendChild(
                    buildSuggestionRow(
                        url,
                        markerFor(url, activeKind),
                        (v) => acceptSuggestion(v, activeKind)
                    )
                );
            }
            return;
        }
    }

    function acceptSuggestion(value, kind) {
        if (!activeField) return;
        setNativeValue(activeField, value);
        if (browser && browser.runtime && browser.runtime.sendMessage) {
            const messageType =
                kind === 'excluded' ? 'EXCLUDED_ACCEPTED' : 'AUTOFILL_ACCEPTED';
            browser.runtime
                .sendMessage({ type: messageType, url: value })
                .catch(() => { });
        }
        // Optimistic update so the marker reflects the choice immediately.
        if (kind === 'excluded') {
            if (!cachedSnapshot.excluded.includes(value)) {
                cachedSnapshot.excluded = [
                    ...cachedSnapshot.excluded,
                    value
                ];
            }
        } else if (!cachedSnapshot.filled.includes(value)) {
            cachedSnapshot.filled = [...cachedSnapshot.filled, value];
        }
        renderPanel();
    }

    async function loadSnapshot() {
        try {
            const reply = await browser.runtime.sendMessage({
                type: 'GET_STATUS'
            });
            if (reply && reply.ok !== false) {
                cachedSnapshot = {
                    targetDomain: reply.targetDomain || null,
                    list: Array.isArray(reply.list) ? reply.list : [],
                    filled: Array.isArray(reply.filled) ? reply.filled : [],
                    excluded: Array.isArray(reply.excluded)
                        ? reply.excluded
                        : []
                };
            }
        } catch {
            // Background may be cold-starting.
        }
    }

    async function maybeShowFor(target) {
        if (!isUrlInput(target)) return;
        const kind = await classifyField(target);
        if (!kind) return;
        // It's possible the user moved focus away while we were resolving
        // labels. Bail out if so.
        if (document.activeElement !== target) return;
        activeField = target;
        activeKind = kind;
        ensurePanel();
        renderPanel();
        positionPanel(target);
        await loadSnapshot();
        if (document.activeElement === target) renderPanel();
    }

    document.addEventListener(
        'focusin',
        (event) => {
            if (!isOnCreatePage()) return;
            const t = event.target;
            if (!(t instanceof HTMLElement)) return;
            // Always re-evaluate; the form may have rerendered since the
            // last focus event and labels may now be present.
            maybeShowFor(t);
        },
        true
    );

    document.addEventListener(
        'focusout',
        (event) => {
            // Defer hiding so a click inside the panel can run first.
            setTimeout(() => {
                const ae = document.activeElement;
                if (
                    ae &&
                    panel &&
                    (panel === ae || panel.contains(ae))
                ) {
                    return;
                }
                if (event.target === activeField) {
                    activeField = null;
                    activeKind = null;
                    destroyPanel();
                }
            }, 50);
        },
        true
    );

    window.addEventListener('resize', () => {
        if (activeField) positionPanel(activeField);
    });
    window.addEventListener(
        'scroll',
        () => {
            if (activeField) positionPanel(activeField);
        },
        true
    );

    // React to background pushes when the popup updates the filled set.
    if (browser && browser.runtime && browser.runtime.onMessage) {
        browser.runtime.onMessage.addListener((message) => {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'FILLED_UPDATED') {
                cachedSnapshot.filled = Array.isArray(message.filled)
                    ? message.filled
                    : [];
                cachedSnapshot.excluded = Array.isArray(message.excluded)
                    ? message.excluded
                    : [];
                renderPanel();
            }
        });
    }

    // If the user focuses a URL field before our content script attaches
    // its focus listener (e.g. they clicked into the field while the page
    // was still mounting), pick up the active element on load.
    if (
        isOnCreatePage() &&
        document.activeElement &&
        document.activeElement !== document.body
    ) {
        maybeShowFor(document.activeElement);
    }

    // SPA navigation handling. The host (`*.securityagent.global.app.aws`)
    // is a React single-page app that updates the URL via
    // history.pushState / replaceState. Our `document_start` injection
    // runs once per real page load, so without this hook the script
    // would miss in-app navigations to /create. Patch the history API
    // and listen for `popstate` so we re-evaluate on every URL change.
    let lastHref = location.href;
    function handleUrlChange() {
        if (location.href === lastHref) return;
        lastHref = location.href;
        // Tear down any panel anchored to a field on the previous page.
        if (activeField) {
            activeField = null;
            activeKind = null;
            destroyPanel();
        }
        // If we're now on the create page and an input is already focused
        // (rare during a route transition, but possible), pick it up.
        if (
            isOnCreatePage() &&
            document.activeElement &&
            document.activeElement !== document.body
        ) {
            maybeShowFor(document.activeElement);
        }
    }
    const origPushState = history.pushState;
    history.pushState = function patchedPushState(...args) {
        const result = origPushState.apply(this, args);
        handleUrlChange();
        return result;
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function patchedReplaceState(...args) {
        const result = origReplaceState.apply(this, args);
        handleUrlChange();
        return result;
    };
    window.addEventListener('popstate', handleUrlChange);
})();
