import { getDateKey } from './common/time.js';
import { saveStateToIDB, loadStateFromIDB, saveUsageToIDB, loadUsageForDate } from './common/idb.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const VIEW_SESSION_TIMEOUT = 60 * SEC;

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
        workHours: { start: 9, end: 17 },
        workDays: [1, 2, 3, 4, 5],
        lunchWindow: { start: 11, end: 15 },
        lunchDurationMs: 45 * MIN,
        maxLunchSessions: 3,
        graceDurationMs: 5 * MIN,
        eveningGraceDurationMs: 30 * MIN
    },
    hackerNews: {
        hosts: ['news.ycombinator.com'],
        workHours: { start: 9, end: 17 },
        workDays: [1, 2, 3, 4, 5],
        graceDurationMs: 5 * MIN
    }
};

const domainMap = buildDomainMap(POLICIES);

let sessions = {};
let usage = {};
let viewSessions = {};

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
            viewSessions: {},
            lastSaved: Date.now(),
            dataVersion: '4.0.0'
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

function ensureUsageObject(host, date) {
    if (!usage[date]) usage[date] = {};
    if (typeof usage[date][host] === 'number') {
        usage[date][host] = { time: usage[date][host], views: 0, tempAccessCount: 0, lunchCount: 0, firstAccess: null, lastAccess: null };
    }
    if (!usage[date][host]) {
        usage[date][host] = { time: 0, views: 0, tempAccessCount: 0, lunchCount: 0, firstAccess: null, lastAccess: null };
    }
    if (!usage[date][host].hasOwnProperty('firstAccess')) {
        usage[date][host].firstAccess = null;
    }
    if (!usage[date][host].hasOwnProperty('lastAccess')) {
        usage[date][host].lastAccess = null;
    }
    if (!usage[date][host].hasOwnProperty('lunchCount')) {
        usage[date][host].lunchCount = 0;
    }
}

function getGroupFirstAccess(group, today) {
    if (!usage[today]) return null;

    let earliest = null;
    for (const [domain, data] of Object.entries(usage[today])) {
        const domainInfo = lookupGroup(domain, domainMap);
        if (domainInfo?.group === group && data.firstAccess) {
            if (!earliest || data.firstAccess < earliest) {
                earliest = data.firstAccess;
            }
        }
    }
    return earliest;
}

function getTotalLunchCount(today) {
    if (!usage[today] || !usage[today]['__lunch__']) return 0;
    return usage[today]['__lunch__'].lunchCount || 0;
}

function cleanupExpiredViewSessions(targetDate, forceEnd = false) {
    const now = Date.now();
    const sessionsToClean = [];

    for (const [domain, timestamp] of Object.entries(viewSessions)) {
        const isExpired = (now - timestamp) > VIEW_SESSION_TIMEOUT;
        if (forceEnd || isExpired) {
            sessionsToClean.push(domain);
        }
    }

    for (const domain of sessionsToClean) {
        delete viewSessions[domain];
    }

    if (sessionsToClean.length > 0) {
        console.log(`[ViewSessions] Cleaned up ${sessionsToClean.length} sessions for ${targetDate}${forceEnd ? ' (forced)' : ''}`);
    }
}

function migrateState(state) {
    const version = state.dataVersion || '1.0.0';

    console.log('[Migrate] Current data version:', version);

    if (version === '4.0.0') {
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

    migratedState.dataVersion = '4.0.0';
    console.log('[Migrate] Migrated state from', version, 'to 4.0.0');

    return migratedState;
}

async function loadState() {
    const state = await loadStateFromIDB();

    sessions = state.sessions;
    viewSessions = state.viewSessions || {};

    const now = Date.now();
    for (const key in sessions) {
        if (sessions[key].expiresAt < now) {
            delete sessions[key];
        }
    }

    const today = getDateKey();
    usage[today] = await loadUsageForDate(today);

    // Reset any firstAccess times before 6am
    if (usage[today]) {
        for (const [domain, data] of Object.entries(usage[today])) {
            if (data.firstAccess) {
                const accessDate = new Date(data.firstAccess);
                if (accessDate.getHours() < 6) {
                    console.log(`[LoadState] Resetting ${domain} firstAccess from ${accessDate.toLocaleTimeString()} (before 6am)`);
                    data.firstAccess = null;
                }
            }
        }
    }

    cleanupExpiredViewSessions(today);

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
        const today = getDateKey();
        cleanupExpiredViewSessions(today);

        const now = Date.now();
        const stateToSave = {
            sessions,
            viewSessions,
            lastSaved: now,
            dataVersion: '4.0.0'
        };

        if (!validateState(stateToSave)) {
            throw new Error('State validation failed - refusing to write corrupted data');
        }

        await saveStateToIDB(stateToSave);

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
        const sessionKey = alarm.name.substring(8);
        delete sessions[sessionKey];
        await saveState();
        if (sessionKey === 'streaming') {
            notifyStreamingTabs();
        } else {
            notifyTabsOfBlock(sessionKey);
        }
    }
});

async function handleMidnight() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getDateKey(yesterday);

    if (!usage[yesterdayKey]) {
        usage[yesterdayKey] = await loadUsageForDate(yesterdayKey);
    }

    cleanupExpiredViewSessions(yesterdayKey, true);

    if (usage[yesterdayKey]) {
        await saveUsageToIDB(yesterdayKey, usage[yesterdayKey]);
    }

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

    const activeSession = sessions[host] || (group === 'streaming' ? sessions['streaming'] : null);
    if (activeSession && activeSession.expiresAt > now) {
        return {
            allow: true,
            group,
            remainingMs: activeSession.expiresAt - now
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

        const isWorkDay = config.workDays.includes(day);
        const isWorkHours = isWorkDay && hour >= config.workHours.start && hour < config.workHours.end;
        const isEveningHours = hour >= 21 || hour < 2;

        if (!isWorkHours && !isEveningHours) {
            return { allow: true, group };
        }

        if (isEveningHours) {
            return {
                allow: false,
                group,
                reason: 'Blocked during evening hours (9pm-2am). 30-minute session available.',
                graceDurationMs: config.eveningGraceDurationMs
            };
        }

        const firstAccess = getGroupFirstAccess('streaming', today);

        if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            if (timeSinceFirst >= HOUR) {
                const totalLunchCount = getTotalLunchCount(today);
                if (hour >= config.lunchWindow.start && hour < config.lunchWindow.end && totalLunchCount < config.maxLunchSessions) {
                    return {
                        allow: false,
                        group,
                        reason: 'Daily allowance used. Lunch session available.',
                        lunchAvailable: true,
                        lunchCount: totalLunchCount,
                        maxLunchSessions: config.maxLunchSessions,
                        graceDurationMs: config.graceDurationMs
                    };
                }
                return {
                    allow: false,
                    group,
                    reason: 'Daily 1-hour allowance exhausted. Blocked during work hours.',
                    lunchCount: totalLunchCount,
                    maxLunchSessions: config.maxLunchSessions,
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
            return {
                allow: true,
                group,
                allowanceRemaining: HOUR
            };
        }
    }

    if (group === 'hackerNews') {
        const date = new Date();
        const hour = date.getHours();
        const day = date.getDay();

        const isWorkDay = config.workDays.includes(day);
        const isWorkHours = isWorkDay && hour >= config.workHours.start && hour < config.workHours.end;
        const isEveningHours = hour >= 21 || hour < 2;

        if (!isWorkHours && !isEveningHours) {
            return { allow: true, group };
        }

        if (isEveningHours) {
            return {
                allow: false,
                group,
                reason: 'Blocked during evening hours (9pm-2am).',
                graceDurationMs: config.graceDurationMs
            };
        }

        return {
            allow: false,
            group,
            reason: 'Blocked during work hours. 5-minute grace available.',
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

    const activeSession = sessions[host] || (group === 'streaming' ? sessions['streaming'] : null);
    if (activeSession && activeSession.expiresAt > now) {
        const remainingMs = activeSession.expiresAt - now;
        info.sessionType = activeSession.type;
        info.sessionRemaining = Math.ceil(remainingMs / 1000);
    }

    if (group === 'social') {
        info.status = 'Always blocked (5-min grace available)';
    } else if (group === 'streaming') {
        const date = new Date();
        const hour = date.getHours();
        const day = date.getDay();
        const today = getDateKey();
        const firstAccess = getGroupFirstAccess('streaming', today);
        const isWorkDay = config.workDays.includes(day);
        const isWorkHours = isWorkDay && hour >= config.workHours.start && hour < config.workHours.end;
        const isEveningHours = hour >= 21 || hour < 2;

        if (isEveningHours) {
            info.status = 'Blocked during evening hours (30-minute session available)';
        } else if (!isWorkHours) {
            info.status = 'Not blocked (outside restricted hours)';
        } else if (firstAccess) {
            const timeSinceFirst = now - firstAccess;
            const remainingMs = HOUR - timeSinceFirst;

            if (remainingMs > 0) {
                info.allowanceRemaining = Math.ceil(remainingMs / 1000);
                info.status = `${Math.ceil(remainingMs / 60000)} min remaining of daily allowance`;
            } else {
                info.status = 'Daily 1-hour allowance exhausted';
                const totalLunchCount = getTotalLunchCount(today);
                if (hour >= config.lunchWindow.start && hour < config.lunchWindow.end && totalLunchCount < config.maxLunchSessions) {
                    info.lunchAvailable = true;
                }
            }
        } else {
            info.allowanceRemaining = 3600;
            info.status = '1 hour daily allowance available';
        }
    } else if (group === 'hackerNews') {
        const date = new Date();
        const hour = date.getHours();
        const day = date.getDay();

        const isWorkDay = config.workDays.includes(day);
        const isWorkHours = isWorkDay && hour >= config.workHours.start && hour < config.workHours.end;
        const isEveningHours = hour >= 21 || hour < 2;

        if (isEveningHours) {
            info.status = 'Blocked during evening hours (9pm-2am)';
        } else if (!isWorkHours) {
            info.status = 'Not blocked (outside restricted hours)';
        } else {
            info.status = 'Blocked during work hours (5-min grace available)';
        }
    }

    return info;
}

async function startSession(host, type, durationMs) {
    const now = Date.now();
    const expiresAt = now + durationMs;

    const sessionKey = type === 'lunch' ? 'streaming' : host;

    sessions[sessionKey] = {
        type,
        startedAt: now,
        expiresAt
    };

    chrome.alarms.create(`session-${sessionKey}`, { when: expiresAt });

    if (type === 'lunch') {
        const today = getDateKey();
        if (!usage[today]) usage[today] = {};
        if (!usage[today]['__lunch__']) {
            usage[today]['__lunch__'] = { lunchCount: 0 };
        }
        usage[today]['__lunch__'].lunchCount++;
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

            cleanupExpiredViewSessions(today);

            ensureUsageObject(host, today);

            const now = Date.now();
            const currentHour = new Date(now).getHours();

            // Only set firstAccess if it's 6am or later
            if (!usage[today][host].firstAccess && currentHour >= 6) {
                usage[today][host].firstAccess = now;
            }
            usage[today][host].lastAccess = now;

            const milliseconds = seconds * 1000;
            usage[today][host].time += milliseconds;

            if (viewSessions[host]) {
                viewSessions[host] = Date.now();
            } else {
                viewSessions[host] = Date.now();
                usage[today][host].views++;
                console.log(`[RecordUsage] ${host}: New view session started`);
            }

            console.log(`[RecordUsage] ${host}: +${seconds}s, total today: ${Math.round(usage[today][host].time/1000)}s, views: ${usage[today][host].views}`);

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
            cleanupExpiredViewSessions(today);
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
    } else if (request.action === 'recordTempAccess') {
        ensureReady().then(() => {
            const { host } = request;
            const today = getDateKey();

            cleanupExpiredViewSessions(today);

            ensureUsageObject(host, today);
            usage[today][host].tempAccessCount++;

            console.log(`[RecordTempAccess] ${host}: temp access count = ${usage[today][host].tempAccessCount}`);

            return saveState();
        }).then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            console.error('[RecordTempAccess] Failed:', error);
            sendResponse({ success: false, error: error.message });
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

async function notifyStreamingTabs() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (tab.url) {
            const host = getHost(tab.url);
            const domainInfo = lookupGroup(host, domainMap);
            if (domainInfo?.group === 'streaming') {
                chrome.tabs.sendMessage(tab.id, { action: 'sessionExpired' }).catch(() => {});
            }
        }
    }
}
