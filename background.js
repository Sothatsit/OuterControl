import { getDateKey } from './common/time.js';
import { saveStateToIDB, loadStateFromIDB, saveUsageToIDB, loadUsageForDate } from './common/idb.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

function buildDomainMap(policies) {
    const map = new Map();
    for (const [group, config] of Object.entries(policies)) {
        for (const domain of config.hosts) {
            map.set(domain, { group, config });
        }
    }
    return map;
}

function lookupGroup(host, domainMap) {
    if (domainMap.has(host)) {
        return domainMap.get(host);
    }

    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join('.');
        if (domainMap.has(suffix)) {
            return domainMap.get(suffix);
        }
    }

    return null;
}

const POLICIES = {
    social: {
        hosts: ['reddit.com', 'twitter.com', 'x.com'],
        blockAlways: true,
        graceDurationMs: 5 * MIN
    },
    streaming: {
        hosts: ['youtube.com', 'disneyplus.com', 'paramountplus.com', 'max.com', 'hbomax.com', 'netflix.com'],
        workHours: { start: 9, end: 18 },
        workDays: [1, 2, 3, 4, 5],
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

const domainMap = buildDomainMap(POLICIES);

let sessions = {};
let quotas = { hn: [] };
let lunchUsed = {};
let streamingFirstAccess = {};
let usage = {};

let ready = false;
let readyPromise = null;
let readyResolve = null;

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[Init] Extension installed/updated, reason:', details.reason);
    await initialize();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[Init] Browser startup');
    await initialize();
});

async function ensureOffscreenDoc() {
    if (!chrome.offscreen?.createDocument) return false;
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return true;

    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Request persistent storage once at startup'
    });
    return true;
}

function waitForPersistenceResult(timeoutMs = 5000) {
    return new Promise(async (resolve) => {
        let timer = setTimeout(() => resolve({ granted: false, timeout: true }), timeoutMs);

        const listener = (msg) => {
            if (msg?.type === 'PERSISTENCE_RESULT') {
                clearTimeout(timer);
                chrome.runtime.onMessage.removeListener(listener);
                resolve({ granted: !!msg.granted, error: msg.error, reason: msg.reason });
            }
        };
        chrome.runtime.onMessage.addListener(listener);

        await ensureOffscreenDoc();
    });
}

async function initialize() {
    if (!readyPromise) {
        readyPromise = new Promise(resolve => {
            readyResolve = resolve;
        });
    }

    const result = await waitForPersistenceResult();
    console.log('[Init] Persistent storage:', result.granted ? 'granted' : 'not granted', result);

    // Verify storage environment - don't throw on persist() denial
    try {
        const hasUnlimited = await chrome.permissions.contains({ permissions: ['unlimitedStorage'] });
        if (!hasUnlimited) throw new Error('unlimitedStorage missing from manifest');

        await saveStateToIDB({
            sessions: {},
            quotas: { hn: [] },
            lunchUsed: {},
            streamingFirstAccess: {},
            lastSaved: Date.now(),
            dataVersion: '3.0.0'
        });

        if (navigator.storage?.estimate) {
            const { usage, quota } = await navigator.storage.estimate();
            console.log('[Init] Storage estimate:', { usage, quota });
        }
    } catch (e) {
        console.error('[Init] Storage environment check failed:', e);
        throw e;
    }

    await loadState();

    setupAlarms();
    ready = true;
    readyResolve();

    console.log('[Init] Initialization complete');
}

async function ensureReady() {
    if (!ready) {
        if (!readyPromise) {
            await initialize();
        }
        await readyPromise;
    }
}

chrome.runtime.onSuspend.addListener(() => {
    console.log('[Suspend] Extension suspending, saving state...');
    saveState();  // May not complete, but we try
});

function migrateState(state) {
    const version = state.dataVersion || '1.0.0';

    console.log('[Migrate] Current data version:', version);

    if (version === '3.0.0') {
        return state;
    }

    let migratedState = { ...state };

    // Add any future migrations here
    // Example:
    // if (version < '2.0.0') {
    //     migratedState = migrateFrom1To2(migratedState);
    // }
    // if (version < '3.0.0') {
    //     migratedState = migrateFrom2To3(migratedState);
    // }

    migratedState.dataVersion = '3.0.0';
    console.log('[Migrate] Migrated state from', version, 'to 3.0.0');

    return migratedState;
}

async function loadState() {
    const state = await loadStateFromIDB();

    sessions = state.sessions;
    quotas = state.quotas;
    lunchUsed = state.lunchUsed;
    streamingFirstAccess = state.streamingFirstAccess;

    const now = Date.now();
    for (const key in sessions) {
        if (sessions[key].expiresAt < now) {
            delete sessions[key];
        }
    }

    const today = getDateKey();
    usage[today] = await loadUsageForDate(today);

    console.log('[LoadState] Loaded from IndexedDB');
}

let saving = false;

function validateState(state) {
    if (!state || typeof state !== 'object') return false;
    if (!state.dataVersion) return false;
    return true;
}

async function saveState() {
    if (saving) return;

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

        if (!validateState(stateToSave)) {
            throw new Error('State validation failed - refusing to write corrupted data');
        }

        await saveStateToIDB(stateToSave);

        const today = getDateKey();
        if (usage[today]) {
            await saveUsageToIDB(today, usage[today]);
        }

        console.log('[SaveState] State saved to IndexedDB');
    } finally {
        saving = false;
    }
}

function scheduleMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    chrome.alarms.create('midnight', { when: midnight.getTime() });
}

function setupAlarms() {
    scheduleMidnight();
    chrome.alarms.create('saveUsage', { periodInMinutes: 5 });
}

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

async function handleMidnight() {
    lunchUsed = {};
    streamingFirstAccess = {};

    const today = getDateKey();
    usage[today] = await loadUsageForDate(today);

    await saveState();
    scheduleMidnight();
}

function getHost(url) {
    try {
        const u = new URL(url);
        return u.hostname;
    } catch {
        return null;
    }
}

async function evaluateAccess(host) {
    const now = Date.now();
    const domainInfo = lookupGroup(host, domainMap);

    if (!domainInfo) {
        return { allow: true };
    }

    const { group, config } = domainInfo;

    if (sessions[host] && sessions[host].expiresAt > now) {
        return {
            allow: true,
            group,
            remainingMs: sessions[host].expiresAt - now
        };
    }

    if (group === 'social') {
        return {
            allow: false,
            group,
            reason: 'Always blocked. 5-minute grace available.',
            graceDurationMs: config.graceDurationMs
        };
    }

    if (group === 'streaming') {
        const date = new Date();
        const hour = date.getHours();
        const day = date.getDay();
        const today = getDateKey();

        const isWorkHours = config.workDays.includes(day) && hour >= config.workHours.start && hour < config.workHours.end;

        if (!isWorkHours) {
            return { allow: true, group };
        }

        const firstAccess = streamingFirstAccess[today];

        if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            if (timeSinceFirst >= HOUR) {
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
                const remainingMs = HOUR - timeSinceFirst;
                return {
                    allow: true,
                    group,
                    allowanceRemaining: remainingMs
                };
            }
        } else {
            streamingFirstAccess[today] = now;
            await saveState();
            return {
                allow: true,
                group,
                allowanceRemaining: HOUR
            };
        }
    }

    if (group === 'hackerNews') {
        quotas.hn = (quotas.hn || []).filter(timestamp => now - timestamp < config.windowMs);

        if (quotas.hn.length < config.maxVisits) {
            const expiresAt = now + config.visitDurationMs;

            sessions[host] = {
                type: 'hnVisit',
                startedAt: now,
                expiresAt
            };

            quotas.hn.push(now);
            chrome.alarms.create(`session-${host}`, { when: expiresAt });
            await saveState();

            return {
                allow: true,
                group,
                remainingMs: config.visitDurationMs
            };
        }

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

function getSiteInfo(host) {
    const now = Date.now();
    const domainInfo = lookupGroup(host, domainMap);

    if (!domainInfo) {
        return null;
    }

    const { group, config } = domainInfo;
    const info = { group, host };

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
        const isWorkHours = config.workDays.includes(day) && hour >= config.workHours.start && hour < config.workHours.end;

        if (!isWorkHours) {
            info.status = 'Not blocked (outside work hours)';
        } else if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            const remainingMs = HOUR - timeSinceFirst;

            if (remainingMs > 0) {
                info.allowanceRemaining = Math.ceil(remainingMs / 1000);
                info.status = `${Math.ceil(remainingMs / 60000)} min remaining of daily allowance`;
            } else {
                info.status = 'Daily 1-hour allowance exhausted';
                if (hour >= config.lunchWindow.start && hour < config.lunchWindow.end && !lunchUsed[today]) {
                    info.lunchAvailable = true;
                }
            }
        } else {
            info.allowanceRemaining = 3600;
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

async function startSession(host, type, durationMs) {
    const now = Date.now();
    const expiresAt = now + durationMs;

    sessions[host] = {
        type,
        startedAt: now,
        expiresAt
    };

    chrome.alarms.create(`session-${host}`, { when: expiresAt });

    if (type === 'lunch') {
        lunchUsed[getDateKey()] = true;
    } else if (type === 'hnVisit') {
        quotas.hn = quotas.hn || [];
        quotas.hn.push(now);
    }

    await saveState();
    return { success: true, expiresAt };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'checkAccess') {
        ensureReady().then(() => evaluateAccess(request.host)).then(sendResponse).catch(error => {
            console.error('[CheckAccess] Failed:', error);
            sendResponse({ allow: false, error: error.message });
        });
        return true;
    } else if (request.action === 'startSession') {
        ensureReady().then(() => startSession(request.host, request.type, request.durationMs)).then(sendResponse).catch(error => {
            console.error('[StartSession] Failed:', error);
            sendResponse({ success: false, error: error.message });
        });
        return true;
    } else if (request.action === 'recordUsage') {
        ensureReady().then(() => {
            const { host, seconds } = request;
            const today = getDateKey();

            if (!usage[today]) usage[today] = {};
            const milliseconds = seconds * 1000;
            usage[today][host] = (usage[today][host] || 0) + milliseconds;

            console.log(`[RecordUsage] ${host}: +${seconds}s, total today: ${Math.round(usage[today][host]/1000)}s`);

            return saveState();
        }).then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            console.error('[RecordUsage] Save failed:', error);
            sendResponse({ success: false, error: error.message });
        });

        return true;
    } else if (request.action === 'getUsage') {
        ensureReady().then(() => {
            const today = getDateKey();
            const todayUsage = usage[today] || {};
            console.log('[GetUsage] Returning data for', today, 'with', Object.keys(todayUsage).length, 'domains');
            sendResponse({ usage: todayUsage });
        }).catch(error => {
            console.error('[GetUsage] Failed:', error);
            sendResponse({ usage: {}, error: error.message });
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
        }).catch(error => {
            console.error('[GetCurrentSite] Failed:', error);
            sendResponse({ host: null, siteInfo: null, error: error.message });
        });
        return true;
    }
});

async function notifyTabsOfBlock(host) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (tab.url && getHost(tab.url) === host) {
            chrome.tabs.sendMessage(tab.id, { action: 'sessionExpired' }).catch(() => {});
        }
    }
}

