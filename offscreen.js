// Offscreen document for File System Access API operations
// This runs in a Window context which has full access to FSA API

import { getStoredHandle, storeHandle } from './lib/idb.js';

let directoryHandle = null;

// Load handle on startup
async function loadHandle() {
    directoryHandle = await getStoredHandle();
    console.log('Offscreen: Loaded directory handle:', !!directoryHandle);
    return !!directoryHandle;
}

// Write file with persistent permission
async function writeFile(filename, content) {
    try {
        if (!directoryHandle) {
            directoryHandle = await getStoredHandle();
            if (!directoryHandle) {
                throw new Error('No directory handle available');
            }
        }

        console.log('Offscreen: Writing file:', filename);

        // Check permission state
        const permission = await directoryHandle.queryPermission({ mode: 'readwrite' });
        console.log('Offscreen: Current permission:', permission);

        if (permission !== 'granted') {
            // For persistent permissions, this should not prompt if already granted "on every visit"
            const newPermission = await directoryHandle.requestPermission({ mode: 'readwrite' });
            if (newPermission !== 'granted') {
                throw new Error('Permission denied');
            }
        }

        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();

        console.log('Offscreen: File written successfully');
        return { success: true };
    } catch (e) {
        console.error('Offscreen: Write failed:', e);
        return { success: false, error: e.message };
    }
}


// Request persistent permission upgrade
async function requestPersistentPermission() {
    try {
        if (!directoryHandle) {
            directoryHandle = await getStoredHandle();
            if (!directoryHandle) {
                throw new Error('No directory handle available');
            }
        }

        console.log('Offscreen: Requesting persistent permission...');

        // This triggers the 3-way prompt for stored handles
        const state = await directoryHandle.requestPermission({ mode: 'readwrite' });

        if (state !== 'granted') {
            throw new Error('Permission not granted. User must select "Allow on every visit"');
        }

        console.log('Offscreen: Persistent permission granted');
        return { success: true };
    } catch (e) {
        console.error('Offscreen: Persistent permission request failed:', e);
        return { success: false, error: e.message };
    }
}

// Read state.json file with backup recovery and OPFS fallback
async function readStateFile() {
    try {
        // Prefer user-selected folder if present and permission is granted
        if (directoryHandle) {
            try {
                const permission = await directoryHandle.queryPermission({ mode: 'read' });
                if (permission === 'granted') {
                    const fh = await directoryHandle.getFileHandle('state.json');
                    const file = await fh.getFile();
                    const text = await file.text();
                    console.log('Offscreen: State loaded from user folder');
                    return { success: true, state: JSON.parse(text) };
                }
            } catch (e) {
                if (e.name !== 'NotFoundError') {
                    console.error('Offscreen: Failed to read from user folder:', e);
                }
                // Fall through to OPFS
            }
        } else {
            // Try to load stored handle
            directoryHandle = await getStoredHandle();
            if (directoryHandle) {
                try {
                    const permission = await directoryHandle.queryPermission({ mode: 'read' });
                    if (permission === 'granted') {
                        const fh = await directoryHandle.getFileHandle('state.json');
                        const file = await fh.getFile();
                        const text = await file.text();
                        console.log('Offscreen: State loaded from user folder (stored handle)');
                        return { success: true, state: JSON.parse(text) };
                    }
                } catch (e) {
                    if (e.name !== 'NotFoundError') {
                        console.error('Offscreen: Failed to read from stored handle:', e);
                    }
                    // Fall through to OPFS
                }
            }
        }

        // OPFS fallback
        if (navigator.storage && navigator.storage.getDirectory) {
            try {
                const root = await navigator.storage.getDirectory();
                const fh = await root.getFileHandle('state.json');
                const file = await fh.getFile();
                const text = await file.text();
                console.log('Offscreen: State loaded from OPFS');
                return { success: true, state: JSON.parse(text) };
            } catch (e) {
                if (e.name === 'NotFoundError') {
                    console.log('Offscreen: No state.json in OPFS');
                    return { success: true, state: null };
                }
                console.error('Offscreen: OPFS read failed:', e);
                return { success: false, error: e.message, exists: true };
            }
        }

        // Nothing available
        console.log('Offscreen: No filesystem available');
        return { success: true, state: null };
    } catch (e) {
        console.error('Offscreen: Error in readStateFile:', e);
        return { success: false, error: e.message, exists: false };
    }
}

// Write state.json file with atomic write and OPFS fallback
async function writeStateFile(state) {
    try {
        // Validate state object
        if (!state || typeof state !== 'object') {
            throw new Error('Invalid state object');
        }

        const content = JSON.stringify(state, null, 2);

        // Try user-selected folder (no prompts here!)
        if (directoryHandle) {
            try {
                const perm = await directoryHandle.queryPermission({ mode: 'readwrite' });
                if (perm === 'granted') {
                    const fh = await directoryHandle.getFileHandle('state.json', { create: true });
                    const w = await fh.createWritable();
                    await w.write(content);
                    await w.close();
                    console.log('Offscreen: State written to user folder');
                    return { success: true };
                }
            } catch (e) {
                console.error('Offscreen: Failed to write to user folder:', e);
                // Fall through to OPFS
            }
        } else {
            // Try to load stored handle
            directoryHandle = await getStoredHandle();
            if (directoryHandle) {
                try {
                    const perm = await directoryHandle.queryPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        const fh = await directoryHandle.getFileHandle('state.json', { create: true });
                        const w = await fh.createWritable();
                        await w.write(content);
                        await w.close();
                        console.log('Offscreen: State written to user folder (stored handle)');
                        return { success: true };
                    }
                } catch (e) {
                    console.error('Offscreen: Failed to write to stored handle:', e);
                    // Fall through to OPFS
                }
            }
        }

        // OPFS fallback
        if (navigator.storage && navigator.storage.getDirectory) {
            try {
                const root = await navigator.storage.getDirectory();
                const fh = await root.getFileHandle('state.json', { create: true });
                const w = await fh.createWritable();
                await w.write(content);
                await w.close();
                console.log('Offscreen: State written to OPFS');
                return { success: true };
            } catch (e) {
                console.error('Offscreen: OPFS write failed:', e);
                return { success: false, error: `OPFS write failed: ${e.message}` };
            }
        }

        return { success: false, error: 'No writable filesystem available' };
    } catch (e) {
        console.error('Offscreen: Write state failed:', e);
        return { success: false, error: e.message };
    }
}

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Offscreen: Received message:', request.action);

    switch (request.action) {
        case 'offscreen-write':
            writeFile(request.filename, request.content).then(sendResponse);
            return true;

        case 'offscreen-request-persistent':
            requestPersistentPermission().then(sendResponse);
            return true;

        case 'offscreen-check-handle':
            loadHandle().then(hasHandle => {
                sendResponse({ hasHandle });
            });
            return true;

        case 'offscreen-read-state':
            readStateFile().then(sendResponse);
            return true;

        case 'offscreen-write-state':
            writeStateFile(request.state).then(sendResponse);
            return true;
    }
});

// Check permission health periodically
async function monitorPermissions() {
    if (!directoryHandle) return;

    try {
        const permission = await directoryHandle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
            console.warn('[Offscreen] Permission lost, notifying background');
            chrome.runtime.sendMessage({
                action: 'permissionLost',
                permission: permission
            }).catch(() => {
                // Background may not be listening, that's ok
            });
        }
    } catch (e) {
        console.error('[Offscreen] Permission check failed:', e);
    }
}

// Cleanup orphaned temp files on startup
async function cleanupTempFiles() {
    if (!directoryHandle) return;

    try {
        // Clean up temp state file
        await directoryHandle.removeEntry('state.json.tmp');
        console.log('[Offscreen] Cleaned up temp state file');
    } catch (e) {
        // File doesn't exist, that's fine
    }

    try {
        // Clean up any old CSV temp files
        const entries = directoryHandle.values();
        for await (const entry of entries) {
            if (entry.name.endsWith('.tmp')) {
                await directoryHandle.removeEntry(entry.name);
                console.log('[Offscreen] Cleaned up temp file:', entry.name);
            }
        }
    } catch (e) {
        console.error('[Offscreen] Error during temp file cleanup:', e);
    }
}

// Initialize
loadHandle().then(() => {
    // Clean up temp files after handle is loaded
    cleanupTempFiles();

    // Start permission monitoring (check every minute)
    setInterval(monitorPermissions, 60000);

    // Initial permission check
    monitorPermissions();
});