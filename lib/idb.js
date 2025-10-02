// Open IndexedDB database
export async function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('OutsideControl', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('handles')) {
                db.createObjectStore('handles');
            }
        };
    });
}

// Get stored directory handle
export async function getStoredHandle(key = 'exportDirectory') {
    try {
        const db = await openDB();
        const tx = db.transaction(['handles'], 'readonly');
        const store = tx.objectStore('handles');
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('Failed to get stored handle:', e);
        return null;
    }
}

// Store directory handle
export async function storeHandle(handle, key = 'exportDirectory') {
    const db = await openDB();
    const tx = db.transaction(['handles'], 'readwrite');
    const store = tx.objectStore('handles');
    await store.put(handle, key);
}
