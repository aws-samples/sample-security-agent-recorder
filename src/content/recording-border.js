// Content script that draws a pastel purple-and-blue gradient border
// around the page while a recording session is active in this tab.
//
// Injected via `browser.scripting.executeScript` from the background on
// session start, and removed via a follow-up message on stop.

(() => {
    const ELEMENT_ID = 'aws-security-agent-recorder-border';

    function ensureBorder() {
        if (document.getElementById(ELEMENT_ID)) {
            return;
        }
        const overlay = document.createElement('div');
        overlay.id = ELEMENT_ID;
        overlay.setAttribute('aria-hidden', 'true');
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            right: '0',
            bottom: '0',
            pointerEvents: 'none',
            zIndex: '2147483646',
            border: '8px solid transparent',
            borderImage:
                'linear-gradient(135deg, #c4b5fd 0%, #a5b4fc 50%, #93c5fd 100%) 1',
            boxShadow: 'inset 0 0 24px rgba(147, 197, 253, 0.35)'
        });
        const insertNow = () => {
            (document.body || document.documentElement).appendChild(overlay);
        };
        if (document.body) {
            insertNow();
        } else {
            document.addEventListener('DOMContentLoaded', insertNow, {
                once: true
            });
        }
    }

    function removeBorder() {
        const existing = document.getElementById(ELEMENT_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    // Listen for explicit toggle messages from the background.
    if (
        typeof browser !== 'undefined' &&
        browser.runtime &&
        browser.runtime.onMessage
    ) {
        browser.runtime.onMessage.addListener((message) => {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'BORDER_SHOW') ensureBorder();
            if (message.type === 'BORDER_HIDE') removeBorder();
        });
    }

    // Default behavior on injection: show the border. The background calls
    // executeScript on START, so reaching this line means recording is on.
    ensureBorder();
})();
