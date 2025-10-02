(async function() {
    // Only run on top-level frames
    if (window.top !== window) return;

    const host = window.location.hostname;
    const url = window.location.href;

    console.log('[Tracker] Content script loaded on:', host);

    // Skip non-http(s) pages (chrome://, about:, file://, etc.)
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        console.log('[Tracker] Skipping non-http(s) page:', url);
        return;
    }

    // Skip if no hostname (shouldn't happen, but be safe)
    if (!host) {
        console.log('[Tracker] No hostname, skipping');
        return;
    }

    // ========== BLOCKING LOGIC ==========
    // Check access with background
    console.log('[Tracker] Checking access for:', host);
    const response = await chrome.runtime.sendMessage({
        action: 'checkAccess',
        host
    });

    console.log('[Tracker] Access response:', response);

    if (!response.allow) {
        // Redirect to block page
        const blockUrl = chrome.runtime.getURL('blocked.html') +
            '?url=' + encodeURIComponent(url) +
            '&group=' + response.group +
            '&reason=' + encodeURIComponent(response.reason || '') +
            '&lunchAvailable=' + (response.lunchAvailable || false) +
            '&graceMs=' + (response.graceDurationMs || 0);

        window.location.replace(blockUrl);
    } else if (response.remainingMs) {
        // Set timer for session expiry
        setTimeout(() => {
            window.location.replace(chrome.runtime.getURL('blocked.html') +
                '?url=' + encodeURIComponent(url) +
                '&group=' + response.group +
                '&reason=' + encodeURIComponent('Session expired'));
        }, response.remainingMs);
    }

    // Listen for session expiry
    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'sessionExpired') {
            window.location.replace(chrome.runtime.getURL('blocked.html') +
                '?url=' + encodeURIComponent(url) +
                '&group=' + response.group +
                '&reason=' + encodeURIComponent('Session expired'));
        }
    });

    // ========== TRACKING LOGIC ==========
    console.log('[Tracker] Starting tracking for:', host);
    let accumulatedSeconds = 0;
    let lastReportedSeconds = 0;

    // Flush on visibility change (when tab becomes hidden)
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden' && accumulatedSeconds > lastReportedSeconds) {
            const unreported = accumulatedSeconds - lastReportedSeconds;
            try {
                const result = await chrome.runtime.sendMessage({
                    action: 'recordUsage',
                    host,
                    seconds: unreported
                });
                if (result?.success) lastReportedSeconds += unreported;
            } catch {}
        }
    });

    // Single 1s ticker to accumulate and report every 10 ticks
    let ticks = 0;
    setInterval(async () => {
        // Accumulate if visible
        if (document.visibilityState === 'visible') {
            accumulatedSeconds++;
        }

        // Report every 10 ticks when visible
        ticks++;
        if (ticks % 10 === 0 && document.visibilityState === 'visible') {
            const delta = accumulatedSeconds - lastReportedSeconds;
            if (delta > 0) {
                try {
                    const result = await chrome.runtime.sendMessage({
                        action: 'recordUsage',
                        host,
                        seconds: delta
                    });
                    if (result?.success) lastReportedSeconds += delta;
                } catch {}
            }
        }
    }, 1000);

    console.log('[Tracker] Tracking initialized for:', host);
})();
