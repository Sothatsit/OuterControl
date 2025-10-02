// Open IndexedDB database
export async function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('OutsideControl', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            const oldVersion = e.oldVersion;

            // Version 1: handles store (legacy)
            if (oldVersion < 1 && !db.objectStoreNames.contains('handles')) {
                db.createObjectStore('handles');
            }

            // Version 2: state and usage stores
            if (oldVersion < 2) {
                if (!db.objectStoreNames.contains('state')) {
                    db.createObjectStore('state');
                }
                if (!db.objectStoreNames.contains('usage')) {
                    db.createObjectStore('usage');
                }
            }
        };
    });
}

// Get stored directory handle (legacy - for backwards compat)
export async function getStoredHandle(key = 'exportDirectory') {
    const db = await openDB();
    const tx = db.transaction(['handles'], 'readonly');
    const store = tx.objectStore('handles');
    return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Store directory handle (legacy - for backwards compat)
export async function storeHandle(handle, key = 'exportDirectory') {
    const db = await openDB();
    const tx = db.transaction(['handles'], 'readwrite');
    const store = tx.objectStore('handles');
    await store.put(handle, key);
}

// Save state to IndexedDB
export async function saveStateToIDB(state) {
    const db = await openDB();
    const tx = db.transaction(['state'], 'readwrite');
    const store = tx.objectStore('state');

    // Store each piece of state separately for easier access
    await Promise.all([
        store.put(state.sessions, 'sessions'),
        store.put(state.quotas, 'quotas'),
        store.put(state.lunchUsed, 'lunchUsed'),
        store.put(state.streamingFirstAccess, 'streamingFirstAccess'),
        store.put(state.dataVersion, 'dataVersion'),
        store.put(state.lastSaved, 'lastSaved')
    ]);

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Save usage data to IndexedDB (keyed by date)
export async function saveUsageToIDB(date, usageData) {
    const db = await openDB();
    const tx = db.transaction(['usage'], 'readwrite');
    const store = tx.objectStore('usage');
    await store.put(usageData, date);

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadStateFromIDB() {
    const db = await openDB();
    const tx = db.transaction(['state'], 'readonly');
    const store = tx.objectStore('state');

    const [sessions, quotas, lunchUsed, streamingFirstAccess, dataVersion, lastSaved] = await Promise.all([
        new Promise(resolve => { const req = store.get('sessions'); req.onsuccess = () => resolve(req.result); }),
        new Promise(resolve => { const req = store.get('quotas'); req.onsuccess = () => resolve(req.result); }),
        new Promise(resolve => { const req = store.get('lunchUsed'); req.onsuccess = () => resolve(req.result); }),
        new Promise(resolve => { const req = store.get('streamingFirstAccess'); req.onsuccess = () => resolve(req.result); }),
        new Promise(resolve => { const req = store.get('dataVersion'); req.onsuccess = () => resolve(req.result); }),
        new Promise(resolve => { const req = store.get('lastSaved'); req.onsuccess = () => resolve(req.result); })
    ]);

    return {
        sessions: sessions || {},
        quotas: quotas || { hn: [] },
        lunchUsed: lunchUsed || {},
        streamingFirstAccess: streamingFirstAccess || {},
        dataVersion: dataVersion || '3.0.0',
        lastSaved: lastSaved || Date.now()
    };
}

export async function loadUsageForDate(date) {
    const db = await openDB();
    const tx = db.transaction(['usage'], 'readonly');
    const store = tx.objectStore('usage');

    return new Promise((resolve, reject) => {
        const request = store.get(date);
        request.onsuccess = () => resolve(request.result || {});
        request.onerror = () => reject(request.error);
    });
}

export async function getAllUsageForExport() {
    const db = await openDB();
    const tx = db.transaction(['usage'], 'readonly');
    const store = tx.objectStore('usage');

    return new Promise((resolve, reject) => {
        const request = store.getAll();
        const keysRequest = store.getAllKeys();

        request.onsuccess = () => {
            keysRequest.onsuccess = () => {
                const data = request.result;
                const keys = keysRequest.result;
                const result = keys.map((date, i) => ({
                    date,
                    data: data[i]
                }));
                resolve(result);
            };
        };
        request.onerror = () => reject(request.error);
    });
}
