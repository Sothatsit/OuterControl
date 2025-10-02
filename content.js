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

    // Poll every 1 second - increment if visible (Brave blocks hasFocus, so just use visibility)
    setInterval(() => {
        const isVisible = document.visibilityState === 'visible';

        if (isVisible) {
            accumulatedSeconds += 1;
            console.log('[Tracker] Tick:', host, 'accumulated:', accumulatedSeconds);
        } else {
            console.log('[Tracker] Not counting (visible:', isVisible, ')');
        }
    }, 1000);

    // Report every 10 seconds (only if we have unreported time AND we're currently visible)
    setInterval(async () => {
        const unreportedSeconds = accumulatedSeconds - lastReportedSeconds;

        console.log('[Tracker] Report interval - unreported:', unreportedSeconds, 'visible:', document.visibilityState);

        // Only send if we have new time AND we're currently visible
        if (unreportedSeconds > 0 && document.visibilityState === 'visible') {

            console.log('[Tracker] Sending usage report:', host, unreportedSeconds, 'seconds');
            try {
                const result = await chrome.runtime.sendMessage({
                    action: 'recordUsage',
                    host: host,
                    seconds: unreportedSeconds
                });

                console.log('[Tracker] Report result:', result);

                if (result && result.success) {
                    // Subtract only the amount we successfully reported
                    lastReportedSeconds += unreportedSeconds;
                    console.log('[Tracker] Updated lastReported to:', lastReportedSeconds);
                }
            } catch (e) {
                // Service worker might be restarting, will retry in 10s
                console.log('[Tracker] Failed to report usage, will retry:', e);
            }
        } else {
            console.log('[Tracker] Not sending (unreported <= 0 or not visible)');
        }
    }, 10000);

    console.log('[Tracker] Tracking initialized for:', host);
})();
