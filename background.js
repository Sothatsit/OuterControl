// Configuration
const POLICIES = {
    social: {
        hosts: ['reddit.com', 'twitter.com', 'x.com'],
        blockAlways: true,
        graceDurationMs: 3 * 60 * 1000
    },
    streaming: {
        hosts: ['youtube.com', 'disneyplus.com', 'paramountplus.com', 'max.com', 'hbomax.com', 'netflix.com'],
        workHours: { start: 9, end: 18 },
        workDays: [1, 2, 3, 4, 5], // Mon-Fri
        lunchWindow: { start: 12, end: 14 },
        lunchDurationMs: 30 * 60 * 1000,
        graceDurationMs: 5 * 60 * 1000
    },
    hackerNews: {
        hosts: ['news.ycombinator.com'],
        maxVisits: 3,
        windowMs: 3 * 60 * 60 * 1000,
        visitDurationMs: 5 * 60 * 1000,
        graceDurationMs: 5 * 60 * 1000
    }
};

// State management
let sessions = {};
let quotas = { hn: [] };
let lunchUsed = {};
let streamingFirstAccess = {}; // Track first streaming access time per day
let usage = {};
let exportSettings = null;
let lastSaveTime = Date.now();
let stateHealthy = false; // Only true after successful load from file
let unsavedChanges = false; // Track if we have changes that failed to save

// Initialize - fixed race condition by ensuring loadState completes first
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[Init] Extension installed/updated, reason:', details.reason);
    await initialize();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[Init] Browser startup');
    await initialize();
});

// Unified initialization to prevent race conditions
async function initialize() {
    // CRITICAL: Load state first before any tracking starts
    await loadState();

    // Set up alarms after state is loaded
    setupAlarms();

    console.log('[Init] Initialization complete');
}

// Save tracking data before extension unloads
chrome.runtime.onSuspend.addListener(() => {
    console.log('[Suspend] Extension suspending, saving state...');

    // Note: This is async and may not complete, but we'll try
    saveState();
});

// Migrate state between versions
function migrateState(state) {
    const version = state.dataVersion || '1.0.0';

    console.log('[Migrate] Current data version:', version);

    // Already on latest version
    if (version === '3.0.0') {
        return state;
    }

    // Migration from older versions
    let migratedState = { ...state };

    // Add any future migrations here
    // Example:
    // if (version < '2.0.0') {
    //     migratedState = migrateFrom1To2(migratedState);
    // }
    // if (version < '3.0.0') {
    //     migratedState = migrateFrom2To3(migratedState);
    // }

    // Update to current version
    migratedState.dataVersion = '3.0.0';
    console.log('[Migrate] Migrated state from', version, 'to 3.0.0');

    return migratedState;
}

// Load state from chrome.storage.local and FSA
async function loadState() {
    try {
        // A) Load durable local copy
        let local = null;
        try {
            const got = await chrome.storage.local.get('outsideControl.state');
            local = got['outsideControl.state'] || null;
            if (local) {
                console.log('[LoadState] Loaded from chrome.storage.local');
            }
        } catch (e) {
            console.error('[LoadState] Failed to read chrome.storage.local:', e);
        }

        // B) Try FSA file via offscreen
        await ensureOffscreenDocument();
        let fileResult = null;
        try {
            fileResult = await chrome.runtime.sendMessage({ action: 'offscreen-read-state' });
            if (fileResult && fileResult.success && fileResult.state) {
                console.log('[LoadState] Loaded from FSA file');
            }
        } catch (e) {
            console.error('[LoadState] Failed to read FSA file:', e);
            fileResult = { success: false, exists: false };
        }

        // C) Decide which state to use (prefer the freshest)
        let chosen = null;
        if (fileResult && fileResult.success && fileResult.state) {
            chosen = fileResult.state;
            if (fileResult.recoveredFromBackup) {
                console.warn('[LoadState] Recovered from backup file');
                showErrorBadge('Recovered from backup; main file was corrupted');
            }
        }
        if (local && (!chosen || (local.lastSaved || 0) > (chosen.lastSaved || 0))) {
            chosen = local;
            console.log('[LoadState] Using chrome.storage.local (fresher than file)');
        }

        if (!chosen) {
            // Fresh state
            console.log('[LoadState] No existing state found, initializing fresh state');
            sessions = {};
            quotas = { hn: [] };
            lunchUsed = {};
            streamingFirstAccess = {};
            usage = {};
            exportSettings = null;
            stateHealthy = true; // chrome.storage.local is always available
            return;
        }

        // Load chosen state
        const migrated = migrateState(chosen);
        sessions = migrated.sessions || {};
        quotas = migrated.quotas || { hn: [] };
        lunchUsed = migrated.lunchUsed || {};
        streamingFirstAccess = migrated.streamingFirstAccess || {};
        usage = migrated.usage || {};
        exportSettings = migrated.exportSettings || null;

        // Clean expired sessions
        const now = Date.now();
        for (const key in sessions) {
            if (sessions[key].expiresAt < now) {
                delete sessions[key];
            }
        }

        stateHealthy = true; // State loaded successfully
        console.log('[LoadState] Loaded. Days:', Object.keys(usage).length, 'stateHealthy=', stateHealthy);
    } catch (err) {
        console.error('[LoadState] Failed:', err);
        // Fallback: keep in-memory defaults; local save on first change will persist
        stateHealthy = true; // chrome.storage.local should still work
    }
}

// Save queue to prevent concurrent saves
let saveQueue = null;
let isSaving = false;
let fileSaveRetryCount = 0;
const MAX_FILE_SAVE_RETRIES = 3;

// Validate state integrity before saving
function validateState(state) {
    if (!state || typeof state !== 'object') return false;
    if (!state.usage || typeof state.usage !== 'object') return false;
    if (!state.dataVersion) return false;

    // Check usage structure
    for (const [date, data] of Object.entries(state.usage)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            console.error('[Validate] Invalid date format:', date);
            return false;
        }
        if (typeof data !== 'object') {
            console.error('[Validate] Invalid data type for date:', date);
            return false;
        }
        for (const [host, ms] of Object.entries(data)) {
            if (typeof ms !== 'number' || ms < 0) {
                console.error('[Validate] Invalid time value for', host, ':', ms);
                return false;
            }
        }
    }

    return true;
}

// Save state - chrome.storage.local primary, FSA secondary
async function saveState(force = false) {
    // Queue save if one is already in progress
    if (isSaving) {
        if (!saveQueue) {
            saveQueue = setTimeout(() => {
                saveQueue = null;
                saveState(force);
            }, 100);
        }
        return;
    }

    isSaving = true;

    try {
        const now = Date.now();
        const stateToSave = {
            sessions,
            quotas,
            lunchUsed,
            streamingFirstAccess,
            usage,
            exportSettings,
            lastSaved: now,
            dataVersion: '3.0.0'
        };

        // Basic validation (unchanged)
        if (!validateState(stateToSave) && !force) {
            throw new Error('State validation failed - refusing to write corrupted data');
        }

        // 1) Always persist to extension storage (primary storage)
        await chrome.storage.local.set({ 'outsideControl.state': stateToSave });
        console.log('[SaveState] State saved to chrome.storage.local');

        // 2) Best-effort file persistence via offscreen (optional/secondary)
        const canUseFSA = exportSettings && exportSettings.directoryHandle;
        if (!canUseFSA) {
            lastSaveTime = now;
            unsavedChanges = false;
            stateHealthy = true; // State is healthy if we can save to chrome.storage
            clearErrorBadge();
            isSaving = false;
            return;
        }

        // Ensure offscreen exists, then try write
        await ensureOffscreenDocument();
        const writeResult = await chrome.runtime.sendMessage({
            action: 'offscreen-write-state',
            state: stateToSave
        });

        if (writeResult && writeResult.success) {
            lastSaveTime = now;
            fileSaveRetryCount = 0;
            unsavedChanges = false;
            stateHealthy = true;
            clearErrorBadge();
            console.log('[SaveState] State saved to both chrome.storage.local and file at', new Date(now).toISOString());
        } else {
            throw new Error((writeResult && writeResult.error) || 'Unknown offscreen write error');
        }
    } catch (e) {
        console.error('[SaveState] Save failed:', e);

        // Check if at least chrome.storage succeeded
        try {
            const test = await chrome.storage.local.get('outsideControl.state');
            if (test['outsideControl.state']) {
                console.log('[SaveState] chrome.storage.local save succeeded, file write failed (non-critical)');
                lastSaveTime = Date.now();
                unsavedChanges = false;
                stateHealthy = true;

                // Schedule a retry with alarms (survives worker termination)
                if (fileSaveRetryCount < MAX_FILE_SAVE_RETRIES) {
                    fileSaveRetryCount++;
                    const delayMs = Math.pow(2, fileSaveRetryCount) * 1000; // 2s,4s,8s
                    chrome.alarms.create('retry-file-save', { when: Date.now() + delayMs });
                    showErrorBadge('File save pending - local data safe');
                } else {
                    showErrorBadge('File not saved - local data safe');
                }
                isSaving = false;
                return;
            }
        } catch (testError) {
            console.error('[SaveState] chrome.storage.local verification failed:', testError);
        }

        // Both failed - this is critical
        unsavedChanges = true;
        stateHealthy = false;
        showErrorBadge('Storage error - data not saved');
    } finally {
        isSaving = false;
    }
}

// Schedule next midnight alarm
function scheduleMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    chrome.alarms.create('midnight', { when: midnight.getTime() });
}

// Setup alarms
function setupAlarms() {
    // Midnight rollover
    scheduleMidnight();

    // Save usage and auto-export every 5 minutes
    chrome.alarms.create('saveUsage', { periodInMinutes: 5 });
}

// Alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'midnight') {
        await handleMidnight();
    } else if (alarm.name === 'saveUsage') {
        // Retry failed saves first
        if (unsavedChanges) {
            console.log('[Alarm] Retrying save for unsaved changes');
            fileSaveRetryCount = 0; // Reset retry count for fresh attempt
        }
        await saveState();
        // Auto-export current day if configured
        if (exportSettings && exportSettings.autoExport) {
            await autoExportCSV(getDateKey());
        }
    } else if (alarm.name === 'retry-file-save') {
        // Try to flush to file again; local storage already has the data
        console.log('[Alarm] Retrying file save (local data already safe)');
        await saveState(true);
    } else if (alarm.name.startsWith('session-')) {
        const host = alarm.name.substring(8);
        delete sessions[host];
        await saveState();
        notifyTabsOfBlock(host);
    }
});

// Handle midnight rollover
async function handleMidnight() {
    const yesterday = getDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

    // Export yesterday's CSV
    if (usage[yesterday]) {
        await autoExportCSV(yesterday);
    }

    // Reset daily state
    lunchUsed = {};
    streamingFirstAccess = {};

    // Clean old usage data (keep last 30 days)
    const cutoff = getDateKey(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    for (const date in usage) {
        if (date < cutoff) {
            delete usage[date];
        }
    }

    await saveState();

    // Schedule next midnight
    scheduleMidnight();
}

// Get browser name - async to handle Brave's Promise-based API
async function getBrowserName() {
    // Check for Brave first using its API (it returns a Promise in newer versions)
    try {
        if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
            const isBrave = await navigator.brave.isBrave();
            if (isBrave) {
                console.log('[Browser] Detected Brave browser');
                return 'brave';
            }
        }
    } catch (e) {
        // Not Brave or old version, continue with UA detection
        console.log('[Browser] Brave detection failed, using UA:', e.message);
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('edg')) return 'edge'; // Check Edge before Chrome
    if (userAgent.includes('chrome')) return 'chrome';
    if (userAgent.includes('firefox')) return 'firefox';
    if (userAgent.includes('safari')) return 'safari';
    return 'unknown';
}

// Show error badge to notify user
function showErrorBadge(message) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e53e3e' });
    chrome.action.setTitle({ title: message || 'Storage error - click for details' });
}

// Clear error badge
function clearErrorBadge() {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Outside-Control' });
}

// Get date key (YYYY-MM-DD) in local timezone
function getDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Get host from URL
function getHost(url) {
    try {
        const u = new URL(url);
        return u.hostname;
    } catch {
        return null;
    }
}

// Get domain group
function getDomainGroup(host) {
    for (const [group, config] of Object.entries(POLICIES)) {
        for (const domain of config.hosts) {
            if (host === domain || host.endsWith('.' + domain)) {
                return { group, config };
            }
        }
    }
    return null;
}

// Evaluate access
async function evaluateAccess(host) {
    const now = Date.now();
    const domainInfo = getDomainGroup(host);

    if (!domainInfo) {
        return { allow: true };
    }

    const { group, config } = domainInfo;

    // Check for active session
    if (sessions[host] && sessions[host].expiresAt > now) {
        return {
            allow: true,
            group,
            remainingMs: sessions[host].expiresAt - now
        };
    }

    // Social - always blocked
    if (group === 'social') {
        return {
            allow: false,
            group,
            reason: 'Always blocked. 5-minute grace available.'
        };
    }

    // Streaming - work hours check with 1-hour daily allowance
    if (group === 'streaming') {
        const date = new Date();
        const hour = date.getHours();
        const day = date.getDay();
        const today = getDateKey();

        // Check if currently in work hours
        const isWorkHours = config.workDays.includes(day) && hour >= config.workHours.start && hour < config.workHours.end;

        // Outside work hours = unlimited access
        if (!isWorkHours) {
            return { allow: true, group };
        }

        // During work hours: check 1-hour daily allowance
        const firstAccess = streamingFirstAccess[today];
        const ONE_HOUR_MS = 60 * 60 * 1000;

        if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            if (timeSinceFirst >= ONE_HOUR_MS) {
                // 1-hour allowance used up during work hours
                // Check lunch window
                if (hour >= config.lunchWindow.start && hour < config.lunchWindow.end && !lunchUsed[today]) {
                    return {
                        allow: false,
                        group,
                        reason: 'Daily allowance used. Lunch session available.',
                        lunchAvailable: true
                    };
                }
                return {
                    allow: false,
                    group,
                    reason: 'Daily 1-hour allowance exhausted. Blocked during work hours.'
                };
            } else {
                // Still within allowance
                const remainingMs = ONE_HOUR_MS - timeSinceFirst;
                return {
                    allow: true,
                    group,
                    allowanceRemaining: remainingMs
                };
            }
        } else {
            // First access today - record it and allow
            streamingFirstAccess[today] = now;
            await saveState();
            return {
                allow: true,
                group,
                allowanceRemaining: ONE_HOUR_MS
            };
        }
    }

    // Hacker News - quota check
    if (group === 'hackerNews') {
        // Clean old visits
        quotas.hn = (quotas.hn || []).filter(timestamp => now - timestamp < config.windowMs);

        if (quotas.hn.length < config.maxVisits) {
            // Start a visit immediately and allow access
            const expiresAt = now + config.visitDurationMs;

            sessions[host] = {
                type: 'hnVisit',
                startedAt: now,
                expiresAt
            };

            // Add to quota
            quotas.hn.push(now);

            // Set alarm for expiry
            chrome.alarms.create(`session-${host}`, { when: expiresAt });

            // Save state
            await saveState();

            return {
                allow: true,
                group,
                remainingMs: config.visitDurationMs
            };
        }

        // Quota exceeded
        const oldestVisit = Math.min(...quotas.hn);
        const nextAllowed = oldestVisit + config.windowMs;

        return {
            allow: false,
            group,
            reason: `Quota exceeded. Next visit at ${new Date(nextAllowed).toLocaleTimeString()}`
        };
    }

    return { allow: true };
}

// Get site info for current tab
function getSiteInfo(host) {
    const now = Date.now();
    const domainInfo = getDomainGroup(host);

    if (!domainInfo) {
        return null;
    }

    const { group, config } = domainInfo;
    const info = { group, host };

    // Check for active session
    if (sessions[host] && sessions[host].expiresAt > now) {
        const remainingMs = sessions[host].expiresAt - now;
        info.sessionType = sessions[host].type;
        info.sessionRemaining = Math.ceil(remainingMs / 1000);
    }

    if (group === 'social') {
        info.status = 'Always blocked (5-min grace available)';
    } else if (group === 'streaming') {
        const date = new Date();
        const hour = date.getHours();
        const day = date.getDay();
        const today = getDateKey();
        const firstAccess = streamingFirstAccess[today];
        const ONE_HOUR_MS = 60 * 60 * 1000;

        if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            const remainingMs = ONE_HOUR_MS - timeSinceFirst;

            if (remainingMs > 0) {
                info.allowanceRemaining = Math.ceil(remainingMs / 1000);
                info.status = `${Math.ceil(remainingMs / 60000)} min remaining of daily allowance`;
            } else {
                info.status = 'Daily 1-hour allowance exhausted';
                if (config.workDays.includes(day) && hour >= config.workHours.start && hour < config.workHours.end) {
                    if (hour >= config.lunchWindow.start && hour < config.lunchWindow.end && !lunchUsed[today]) {
                        info.lunchAvailable = true;
                    }
                }
            }
        } else {
            info.allowanceRemaining = 3600; // 1 hour in seconds
            info.status = '1 hour daily allowance available';
        }
    } else if (group === 'hackerNews') {
        quotas.hn = (quotas.hn || []).filter(timestamp => now - timestamp < config.windowMs);
        const visitsRemaining = config.maxVisits - quotas.hn.length;

        if (visitsRemaining > 0) {
            info.visitsRemaining = visitsRemaining;
            info.status = `${visitsRemaining} visits remaining`;
        } else {
            const oldestVisit = Math.min(...quotas.hn);
            const resetMs = (oldestVisit + config.windowMs) - now;
            info.resetIn = Math.ceil(resetMs / 1000);
            info.status = 'Quota exceeded';
        }
    }

    return info;
}

// Start session
async function startSession(host, type, durationMs) {
    const now = Date.now();
    const expiresAt = now + durationMs;

    sessions[host] = {
        type,
        startedAt: now,
        expiresAt
    };

    // Set alarm for expiry
    chrome.alarms.create(`session-${host}`, { when: expiresAt });

    // Handle specific session types
    if (type === 'lunch') {
        lunchUsed[getDateKey()] = true;
    } else if (type === 'hnVisit') {
        quotas.hn = quotas.hn || [];
        quotas.hn.push(now);
    }

    await saveState();
    return { success: true, expiresAt };
}

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'checkAccess') {
        evaluateAccess(request.host).then(sendResponse);
        return true;
    } else if (request.action === 'startSession') {
        startSession(request.host, request.type, request.durationMs).then(sendResponse);
        return true;
    } else if (request.action === 'recordUsage') {
        // Handle usage reports from content scripts
        const { host, seconds } = request;
        const today = getDateKey();

        if (!usage[today]) usage[today] = {};
        const milliseconds = seconds * 1000;
        usage[today][host] = (usage[today][host] || 0) + milliseconds;

        console.log(`[RecordUsage] ${host}: +${seconds}s, total today: ${Math.round(usage[today][host]/1000)}s`);

        // Save immediately after receiving usage update
        saveState().then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            console.error('[RecordUsage] Save failed:', error);
            sendResponse({ success: false, error: error.message });
        });

        return true; // Keep message channel open for async response
    } else if (request.action === 'ensureOffscreen') {
        ensureOffscreenDocument().then(() => sendResponse({ success: true }));
        return true;
    } else if (request.action === 'offscreen-request-persistent' ||
               request.action === 'offscreen-write' ||
               request.action === 'offscreen-check-handle') {
        // Forward these messages to the offscreen document
        ensureOffscreenDocument().then(async () => {
            try {
                const result = await chrome.runtime.sendMessage(request);
                sendResponse(result);
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        });
        return true;
    } else if (request.action === 'getUsage') {
        const today = getDateKey();
        const todayUsage = usage[today] || {};
        console.log('[GetUsage] Returning data for', today, 'with', Object.keys(todayUsage).length, 'domains');
        sendResponse({ usage: todayUsage });
    } else if (request.action === 'exportCSV') {
        exportCSV(getDateKey()).then(sendResponse);
        return true;
    } else if (request.action === 'getCurrentSite') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].url) {
                const host = getHost(tabs[0].url);
                const siteInfo = getSiteInfo(host);
                sendResponse({ host, siteInfo });
            } else {
                sendResponse({ host: null, siteInfo: null });
            }
        });
        return true;
    } else if (request.action === 'saveExportSettings') {
        (async () => {
            exportSettings = request.settings;
            // If we're setting up for the first time, initialize state
            if (!stateHealthy && request.settings.directoryHandle) {
                await initializeState();
            } else {
                await saveState();
            }
            sendResponse({ success: true });
        })();
        return true;
    } else if (request.action === 'getExportSettings') {
        sendResponse({ settings: exportSettings });
    } else if (request.action === 'initializeState') {
        // Initialize state when folder is first selected
        initializeState().then(success => {
            sendResponse({ success });
        });
        return true;
    } else if (request.action === 'permissionLost') {
        // Permission was revoked, disable auto-export and notify user
        console.error('[PermissionLost] File system permission lost:', request.permission);
        if (exportSettings) {
            exportSettings.persistentPermission = false;
            exportSettings.autoExport = false;
        }
        showErrorBadge('File permission lost - please re-select folder');
        saveState().catch(e => console.error('Failed to save after permission loss:', e));
    }
});

// Notify tabs when blocked
async function notifyTabsOfBlock(host) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (tab.url && getHost(tab.url) === host) {
            chrome.tabs.sendMessage(tab.id, { action: 'sessionExpired' }).catch(() => {});
        }
    }
}

// Initialize state when folder is first configured
async function initializeState() {
    try {
        console.log('[InitState] Initializing fresh state file');

        // Set up fresh state
        sessions = {};
        quotas = { hn: [] };
        lunchUsed = {};
        streamingFirstAccess = {};
        usage = {};

        const browserName = await getBrowserName();
        exportSettings = {
            directoryHandle: true,
            autoExport: true,
            browserName: browserName,
            persistentPermission: true
        };

        stateHealthy = true; // Allow writes

        // Save initial state
        await saveState(true); // Force save even with empty usage

        console.log('[InitState] State file initialized successfully');
        clearErrorBadge(); // Clear any error states
        return true;
    } catch (error) {
        console.error('[InitState] Failed to initialize state:', error);
        stateHealthy = false;
        showErrorBadge('Failed to initialize storage');
        return false;
    }
}

// Generate CSV content
function generateCSV(date) {
    const data = usage[date] || {};
    console.log('Generating CSV for date:', date, 'data:', data);

    // Convert to array and sort by time
    const rows = Object.entries(data)
        .map(([domain, ms]) => ({ domain, seconds: Math.round(ms / 1000) }))
        .sort((a, b) => b.seconds - a.seconds);

    console.log('CSV rows:', rows);

    // Generate CSV
    let csv = 'date,domain,total_seconds\n';
    for (const row of rows) {
        csv += `${date},${row.domain},${row.seconds}\n`;
    }

    console.log('Generated CSV content:', csv);
    return csv;
}

// Export CSV (manual) - use data URL instead of blob URL for service worker compatibility
async function exportCSV(date) {
    const csv = generateCSV(date);

    // Create data URL (works in service worker context)
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);

    await chrome.downloads.download({
        url: dataUrl,
        filename: `outside-control-usage-${date}.csv`,
        conflictAction: 'overwrite'
    });

    return { success: true };
}

// Create offscreen document if needed
let creatingOffscreen;
async function ensureOffscreenDocument() {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });

    if (existingContexts.length > 0) {
        return;
    }

    // Create offscreen document if it doesn't exist
    if (creatingOffscreen) {
        await creatingOffscreen;
    } else {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['LOCAL_STORAGE'],
            justification: 'File System Access API operations for persistent file storage'
        });
        await creatingOffscreen;
        creatingOffscreen = null;
    }
}

// Write file using offscreen document
async function writeFileFromBackground(filename, content) {
    if (!exportSettings || !exportSettings.persistentPermission) {
        console.log('No persistent permission - skipping background write');
        return false;
    }

    try {
        // Ensure offscreen document exists
        await ensureOffscreenDocument();

        // Send message to offscreen document
        const result = await chrome.runtime.sendMessage({
            action: 'offscreen-write',
            filename,
            content
        });

        if (result.success) {
            console.log('Background: File written successfully via offscreen');
            return true;
        } else {
            console.error('Background: File write failed:', result.error);

            // If permissions were revoked, disable auto-export
            if (result.error && (result.error.includes('NotAllowedError') || result.error.includes('NotFoundError'))) {
                console.log('Background: Disabling auto-export due to permission/access error');
                exportSettings = { ...exportSettings, autoExport: false, persistentPermission: false };
                await saveState();
            }
            return false;
        }
    } catch (e) {
        console.error('Background file write failed:', e);
        return false;
    }
}

// Auto-export CSV (to configured directory)
async function autoExportCSV(date) {
    if (!exportSettings || !exportSettings.directoryHandle) {
        return;
    }

    try {
        const csv = generateCSV(date);
        const filename = `outside-control-usage-${date}.csv`;

        // Try background write first (if persistent permission is available)
        if (exportSettings.persistentPermission) {
            console.log('Attempting background file write for:', filename);
            const success = await writeFileFromBackground(filename, csv);
            if (success) {
                console.log('Background export successful');
                return;
            }
            console.log('Background export failed, falling back to message-based approach');
        }

        // Fallback: Send to popup/options page to write
        chrome.runtime.sendMessage({
            action: 'writeFile',
            filename,
            content: csv
        }).catch(() => {
            console.log('No popup open to handle file write - this is expected for background operations');
        });
    } catch (e) {
        console.error('Auto-export failed:', e);
    }
}
