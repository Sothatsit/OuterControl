// Folder picker page - handles initial folder selection with proper user activation

import { getStoredHandle, storeHandle } from './lib/idb.js';

let directoryHandle = null;
let step = 1;

// Initialize page
async function init() {
    const button = document.getElementById('select-folder');
    const status = document.getElementById('status');

    // Check if File System Access API is available
    if (!window.showDirectoryPicker) {
        document.querySelector('h1').textContent = 'Browser Not Supported';

        // Check if this is Brave
        let isBrave = false;
        try {
            if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
                isBrave = await navigator.brave.isBrave();
            }
        } catch (e) {
            // Not Brave
        }

        if (isBrave) {
            document.querySelector('p').innerHTML = `
                <strong>Brave disables the File System Access API by default.</strong><br><br>
                To enable it:<br>
                1. Open <code>brave://flags/#file-system-access-api</code><br>
                2. Set it to <strong>Enabled</strong><br>
                3. Restart Brave<br>
                4. Return here to configure auto-export<br><br>
                <em>Note: The extension will still work without this feature, but CSV exports will be manual downloads instead of automatic file saves.</em>
            `;
        } else {
            document.querySelector('p').innerHTML = `
                The File System Access API is not available in your browser.<br><br>
                <strong>Supported browsers:</strong><br>
                • Chrome version 86 or higher<br>
                • Microsoft Edge version 86 or higher<br>
                • Brave (with flag enabled)<br><br>
                <strong>Not supported:</strong><br>
                • Firefox<br>
                • Safari<br>
                • Older Chrome/Edge versions<br><br>
                Please use a supported browser to enable CSV auto-export.
            `;
        }
        button.style.display = 'none';
        return;
    }

    // Always start at step 1 (folder selection)
    // Step 2 will happen automatically after folder is selected
}

// Handle button click
document.getElementById('select-folder').addEventListener('click', async () => {
    const button = document.getElementById('select-folder');
    const status = document.getElementById('status');

    // Check if the File System Access API is available
    if (!window.showDirectoryPicker) {
        status.className = 'error';
        status.innerHTML = `
            <strong>File System Access API is not supported</strong><br><br>
            This feature requires Chrome or Edge version 86 or higher.<br>
            Please make sure you're using a supported browser.<br><br>
            Note: This API is not available in Firefox or Safari.
        `;
        return;
    }

    if (step === 1) {
        // Step 1: Select folder
        try {
            button.disabled = true;
            button.textContent = 'Selecting folder...';
            status.textContent = '';

            // Request directory picker (we have user activation here!)
            const handle = await window.showDirectoryPicker({
                id: 'web-usage',
                mode: 'readwrite',
                startIn: 'documents'
            });

            directoryHandle = handle;

            // Store handle in IndexedDB
            await storeHandle(handle);

            // Verify handle was actually stored
            const verifyHandle = await getStoredHandle();
            if (!verifyHandle) {
                throw new Error('Failed to store directory handle - IndexedDB may be disabled or quota exceeded');
            }

            console.log('[FolderPicker] Handle stored and verified in IndexedDB');

            // Show success and move to step 2
            status.className = 'success';
            status.innerHTML = '✓ Folder selected!<br>Now let\'s enable background exports...';

            // Update UI for step 2
            step = 2;
            document.querySelector('h1').textContent = 'Enable Background Auto-Export';
            document.querySelector('p').innerHTML = 'Grant persistent permission for automatic CSV exports.<br><br><strong>Important:</strong> Choose "Allow on every visit" in the next dialog.';
            button.textContent = 'Grant Persistent Permission';
            button.disabled = false;

        } catch (e) {
            button.disabled = false;
            button.textContent = 'Select Folder';

            if (e.name === 'AbortError') {
                status.className = 'error';
                status.textContent = 'Selection cancelled.';
            } else {
                status.className = 'error';
                status.textContent = `Error: ${e.message}`;
            }
        }
    } else if (step === 2) {
        // Step 2: Request persistent permission
        try {
            button.disabled = true;
            button.textContent = 'Requesting permission...';
            status.className = '';
            status.innerHTML = 'Choose "Allow on every visit" in the permission dialog...';

            // This triggers the 3-way prompt for persistent permission
            const permission = await directoryHandle.requestPermission({ mode: 'readwrite' });

            if (permission !== 'granted') {
                throw new Error('You must choose "Allow on every visit" for background exports to work');
            }

            // Save settings and initialize state file
            const initResult = await chrome.runtime.sendMessage({
                action: 'saveExportSettings',
                settings: {
                    directoryHandle: true,
                    autoExport: true,
                    persistentPermission: true
                }
            });

            if (!initResult.success) {
                throw new Error('Failed to initialize state file');
            }

            // Show final success
            status.className = 'success';
            status.innerHTML = '🎉 All set! Background auto-export is now enabled.<br>CSV files will be saved every 5 minutes.';
            button.textContent = 'Setup Complete';
            button.style.background = '#48bb78';

            // Auto-close after 3 seconds
            setTimeout(() => {
                window.close();
            }, 3000);

        } catch (e) {
            button.disabled = false;
            button.textContent = 'Try Again';
            status.className = 'error';
            status.innerHTML = `${e.message}<br><br>Click "Try Again" and make sure to choose "Allow on every visit"`;
        }
    }
});

// Initialize on load
init();