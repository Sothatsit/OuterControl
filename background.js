// Import shared modules
import { MIN, HOUR } from './lib/constants.js';
import { getDateKey } from './lib/time.js';
import { buildDomainMap, lookupGroup } from './lib/domains.js';
import { saveStateToIDB, loadStateFromIDB, saveUsageToIDB, loadUsageForDate } from './lib/idb.js';

// Configuration
const POLICIES = {
    social: {
        hosts: ['reddit.com', 'twitter.com', 'x.com'],
        blockAlways: true,
        graceDurationMs: 5 * MIN
    },
    streaming: {
        hosts: ['youtube.com', 'disneyplus.com', 'paramountplus.com', 'max.com', 'hbomax.com', 'netflix.com'],
        workHours: { start: 9, end: 18 },
        workDays: [1, 2, 3, 4, 5], // Mon-Fri
        lunchWindow: { start: 12, end: 14 },
        lunchDurationMs: 30 * MIN,
        graceDurationMs: 5 * MIN
    },
    hackerNews: {
        hosts: ['news.ycombinator.com'],
        maxVisits: 3,
        windowMs: 3 * HOUR,
        visitDurationMs: 5 * MIN,
        graceDurationMs: 5 * MIN
    }
};

// Build domain map for fast lookups
const domainMap = buildDomainMap(POLICIES);

// State management
let sessions = {};
let quotas = { hn: [] };
let lunchUsed = {};
let streamingFirstAccess = {}; // Track first streaming access time per day
let usage = {}; // In-memory cache of usage data

// Initialization guard
let ready = false;
let readyPromise = null;
let readyResolve = null;

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
    // Create ready promise if not already created
    if (!readyPromise) {
        readyPromise = new Promise(resolve => {
            readyResolve = resolve;
        });
    }

    // Request persistent storage
    const isPersisted = await navigator.storage.persist();
    console.log('[Init] Persistent storage:', isPersisted ? 'granted' : 'denied');

    if (!isPersisted) {
        throw new Error('Persistent storage denied - extension cannot function properly');
    }

    // CRITICAL: Load state first before any tracking starts
    await loadState();

    // Set up alarms after state is loaded
    setupAlarms();

    // Mark as ready
    ready = true;
    readyResolve();

    console.log('[Init] Initialization complete');
}

// Wait for initialization to complete
async function ensureReady() {
    if (!ready) {
        if (!readyPromise) {
            // Initialize hasn't been called yet, start it
            await initialize();
        }
        await readyPromise;
    }
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

// Load state from IndexedDB
async function loadState() {
    const state = await loadStateFromIDB();

    sessions = state.sessions;
    quotas = state.quotas;
    lunchUsed = state.lunchUsed;
    streamingFirstAccess = state.streamingFirstAccess;

    // Clean expired sessions
    const now = Date.now();
    for (const key in sessions) {
        if (sessions[key].expiresAt < now) {
            delete sessions[key];
        }
    }

    // Load today's usage into memory cache
    const today = getDateKey();
    usage[today] = await loadUsageForDate(today);

    console.log('[LoadState] Loaded from IndexedDB');
}

// Prevent concurrent saves
let saving = false;

// Validate state integrity before saving
function validateState(state) {
    if (!state || typeof state !== 'object') return false;
    if (!state.dataVersion) return false;
    return true;
}

// Save state to IndexedDB
async function saveState() {
    // Prevent concurrent saves
    if (saving) {
        return;
    }

    saving = true;

    try {
        const now = Date.now();
        const stateToSave = {
            sessions,
            quotas,
            lunchUsed,
            streamingFirstAccess,
            lastSaved: now,
            dataVersion: '3.0.0'
        };

        // Basic validation
        if (!validateState(stateToSave)) {
            throw new Error('State validation failed - refusing to write corrupted data');
        }

        // Save state to IndexedDB
        await saveStateToIDB(stateToSave);

        // Save today's usage to IndexedDB
        const today = getDateKey();
        if (usage[today]) {
            await saveUsageToIDB(today, usage[today]);
        }

        console.log('[SaveState] State saved to IndexedDB');
    } finally {
        saving = false;
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

    // Save usage to IndexedDB every 5 minutes
    chrome.alarms.create('saveUsage', { periodInMinutes: 5 });
}

// Alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'midnight') {
        await handleMidnight();
    } else if (alarm.name === 'saveUsage') {
        await saveState();
    } else if (alarm.name.startsWith('session-')) {
        const host = alarm.name.substring(8);
        delete sessions[host];
        await saveState();
        notifyTabsOfBlock(host);
    }
});

// Handle midnight rollover
async function handleMidnight() {
    // Reset daily state
    lunchUsed = {};
    streamingFirstAccess = {};

    // Load today's usage into cache
    const today = getDateKey();
    usage[today] = await loadUsageForDate(today);

    await saveState();

    // Schedule next midnight
    scheduleMidnight();
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


// Evaluate access
async function evaluateAccess(host) {
    const now = Date.now();
    const domainInfo = lookupGroup(host, domainMap);

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
            reason: 'Always blocked. 5-minute grace available.',
            graceDurationMs: config.graceDurationMs
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

        if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            if (timeSinceFirst >= HOUR) {
                // 1-hour allowance used up during work hours
                // Check lunch window
                if (hour >= config.lunchWindow.start && hour < config.lunchWindow.end && !lunchUsed[today]) {
                    return {
                        allow: false,
                        group,
                        reason: 'Daily allowance used. Lunch session available.',
                        lunchAvailable: true,
                        graceDurationMs: config.graceDurationMs
                    };
                }
                return {
                    allow: false,
                    group,
                    reason: 'Daily 1-hour allowance exhausted. Blocked during work hours.',
                    graceDurationMs: config.graceDurationMs
                };
            } else {
                // Still within allowance
                const remainingMs = HOUR - timeSinceFirst;
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
                allowanceRemaining: HOUR
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
            reason: `Quota exceeded. Next visit at ${new Date(nextAllowed).toLocaleTimeString()}`,
            graceDurationMs: config.graceDurationMs
        };
    }

    return { allow: true };
}

// Get site info for current tab
function getSiteInfo(host) {
    const now = Date.now();
    const domainInfo = lookupGroup(host, domainMap);

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

        if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            const remainingMs = HOUR - timeSinceFirst;

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
        ensureReady().then(() => evaluateAccess(request.host)).then(sendResponse);
        return true;
    } else if (request.action === 'startSession') {
        ensureReady().then(() => startSession(request.host, request.type, request.durationMs)).then(sendResponse);
        return true;
    } else if (request.action === 'recordUsage') {
        // Handle usage reports from content scripts
        ensureReady().then(() => {
            const { host, seconds } = request;
            const today = getDateKey();

            if (!usage[today]) usage[today] = {};
            const milliseconds = seconds * 1000;
            usage[today][host] = (usage[today][host] || 0) + milliseconds;

            console.log(`[RecordUsage] ${host}: +${seconds}s, total today: ${Math.round(usage[today][host]/1000)}s`);

            // Save immediately after receiving usage update
            return saveState();
        }).then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            console.error('[RecordUsage] Save failed:', error);
            sendResponse({ success: false, error: error.message });
        });

        return true; // Keep message channel open for async response
    } else if (request.action === 'getUsage') {
        ensureReady().then(() => {
            const today = getDateKey();
            const todayUsage = usage[today] || {};
            console.log('[GetUsage] Returning data for', today, 'with', Object.keys(todayUsage).length, 'domains');
            sendResponse({ usage: todayUsage });
        });
        return true;
    } else if (request.action === 'getCurrentSite') {
        ensureReady().then(() => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0] && tabs[0].url) {
                    const host = getHost(tabs[0].url);
                    const siteInfo = getSiteInfo(host);
                    sendResponse({ host, siteInfo });
                } else {
                    sendResponse({ host: null, siteInfo: null });
                }
            });
        });
        return true;
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

