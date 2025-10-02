import { getStoredHandle, storeHandle, openDB } from './lib/idb.js';
import { formatTime, formatTimeRemaining } from './lib/time.js';

let directoryHandle = null;

// Load export settings
async function loadExportSettings() {
    console.log('Loading export settings...');
    const response = await chrome.runtime.sendMessage({ action: 'getExportSettings' });
    console.log('Export settings response:', response);

    if (response.settings && response.settings.directoryHandle) {
        console.log('Directory handle configured, attempting to restore...');
        try {
            // Restore handle from IndexedDB
            directoryHandle = await getStoredHandle();
            console.log('Restored directory handle:', directoryHandle);

            if (directoryHandle) {
                console.log('Handle exists with persistent permission');
                updateFolderStatus(true);
            } else {
                console.log('No directory handle found in IndexedDB');
                updateFolderStatus(false);
            }
        } catch (e) {
            console.log('Could not restore directory handle:', e);
            updateFolderStatus(false);
        }
    } else {
        console.log('No directory handle configured');
        updateFolderStatus(false);
    }
}

// Show storage error state
function showStorageError(message) {
    const container = document.getElementById('usage-table');
    container.innerHTML = `
        <div class="no-data">
            <div style="color: #e53e3e;">
                ⚠️ Storage Error: ${message}
            </div>
            <div style="margin-top: 10px; font-size: 12px;">
                Please check folder permissions or re-select the export folder.
            </div>
        </div>
    `;
}

// Check if state system is healthy
async function checkStateHealth() {
    // The background script will tell us if state is healthy through export settings
    const response = await chrome.runtime.sendMessage({ action: 'getExportSettings' });
    return response.settings && response.settings.directoryHandle;
}

// Update folder status display
function updateFolderStatus(configured) {
    const status = document.getElementById('export-status');
    const folderPath = document.getElementById('folder-path');
    const openBtn = document.getElementById('open-folder');

    if (configured) {
        status.classList.add('configured');
        folderPath.innerHTML = `
      <div>✓ Auto-export configured</div>
      <div>Files will be saved to the selected folder</div>
      <div style="font-size: 11px; margin-top: 5px;">CSVs auto-save every 5 minutes</div>
    `;
        openBtn.style.display = 'inline-block';
    } else {
        status.classList.remove('configured');
        folderPath.innerHTML = 'No folder selected - Click "Select Export Folder" to enable auto-export';
        openBtn.style.display = 'none';
    }
}

// Helper function to ensure offscreen document exists
async function ensureOffscreenDocument() {
    // Send a message to background to create offscreen if needed
    await chrome.runtime.sendMessage({ action: 'ensureOffscreen' });
}

// Select folder - open tab for initial selection (requires user activation)
document.getElementById('select-folder').addEventListener('click', async () => {
    console.log('Select folder button clicked');

    try {
        // Open folder picker page in a new tab
        await chrome.tabs.create({
            url: chrome.runtime.getURL('folder-picker.html'),
            active: true
        });

        // Close the popup
        window.close();

    } catch (e) {
        console.error('Error opening folder picker:', e);
        showToast(`Failed to open folder picker: ${e.message}`);
    }
});



// Open folder
document.getElementById('open-folder').addEventListener('click', async () => {
    if (!directoryHandle) return;

    try {
        // Try to verify permission first
        const permission = await directoryHandle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') {
            await directoryHandle.requestPermission({ mode: 'read' });
        }

        // Show folder by creating and opening a temp file
        const tempFile = await directoryHandle.getFileHandle('.temp', { create: true });
        await directoryHandle.removeEntry('.temp');

        alert(`Files are in your selected export folder.\n\nPlease open this folder manually in Finder.`);
    } catch (e) {
        alert(`Files are in your selected export folder.\n\nPlease open this folder manually in Finder.`);
    }
});

// Export today's CSV manually
document.getElementById('export-today').addEventListener('click', async () => {
    console.log('Export today button clicked');
    console.log('Directory handle available:', !!directoryHandle);

    if (directoryHandle) {
        console.log('Using directory handle export');
        const success = await writeCurrentDayCSV();
        if (success) {
            showToast('CSV exported successfully!');
        } else {
            // If directory export failed, try fallback download
            console.log('Directory export failed, trying fallback download');
            showToast('Directory export failed, downloading instead...');

            const result = await chrome.runtime.sendMessage({ action: 'exportCSV' });
            console.log('Fallback export result:', result);
            if (result.success) {
                showToast('CSV downloaded to Downloads folder');
            } else {
                showToast('Export failed. Please try re-selecting the export folder.');
            }
        }
    } else {
        console.log('Using fallback download export');
        // Fallback to download
        const result = await chrome.runtime.sendMessage({ action: 'exportCSV' });
        console.log('Export result:', result);
        if (result.success) {
            showToast('CSV downloaded to Downloads folder');
        } else {
            showToast('CSV export failed');
        }
    }
});


// Write current day's CSV
async function writeCurrentDayCSV() {
    console.log('Writing current day CSV...');
    const today = new Date().toISOString().split('T')[0];
    const result = await chrome.runtime.sendMessage({ action: 'getUsage' });
    const usage = result.usage || {};

    console.log('Usage data for CSV:', usage);

    // Generate CSV
    const rows = Object.entries(usage)
        .map(([domain, ms]) => ({ domain, seconds: Math.round(ms / 1000) }))
        .sort((a, b) => b.seconds - a.seconds);

    let csv = 'date,domain,total_seconds\n';
    for (const row of rows) {
        csv += `${today},${row.domain},${row.seconds}\n`;
    }

    console.log('Generated CSV content:', csv);

    const filename = `outside-control-usage-${today}.csv`;
    console.log('Writing file:', filename);

    // Write using offscreen document
    try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
            action: 'offscreen-write',
            filename,
            content: csv
        });
        console.log('File write result:', result);
        return result.success;
    } catch (e) {
        console.error('Failed to write CSV:', e);
        return false;
    }
}

// Listen for state error messages
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    if (request.action === 'stateError') {
        showStorageError(request.message);
    }
});

// Show toast notification
function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    z-index: 1000;
  `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// Load current site info
async function loadCurrentSite() {
    const response = await chrome.runtime.sendMessage({ action: 'getCurrentSite' });
    const container = document.getElementById('site-info');

    if (!response.host) {
        container.innerHTML = '<div class="no-data">No active site</div>';
        return;
    }

    let html = `<div><strong>${response.host}</strong></div>`;

    if (response.siteInfo) {
        const info = response.siteInfo;

        if (info.sessionRemaining) {
            html += `<div class="status info">Session active: ${formatTimeRemaining(info.sessionRemaining)} remaining</div>`;
        }

        if (info.group === 'hackerNews') {
            if (info.visitsRemaining !== undefined) {
                html += `<div class="status success">${info.visitsRemaining} visits remaining</div>`;
            }
            if (info.resetIn) {
                html += `<div class="status warning">Quota resets in ${formatTimeRemaining(info.resetIn)}</div>`;
            }
        } else if (info.group === 'streaming') {
            html += `<div class="status ${info.status.includes('Blocked') ? 'warning' : 'success'}">${info.status}</div>`;
            if (info.lunchAvailable) {
                html += `<div class="status info">Lunch session available</div>`;
            }
        } else if (info.group === 'social') {
            html += `<div class="status warning">${info.status}</div>`;
        }
    } else {
        html += '<div class="status">Not restricted</div>';
    }

    container.innerHTML = html;
}

// Load and display usage
async function loadUsage() {
    try {
        const result = await chrome.runtime.sendMessage({ action: 'getUsage' });
        const usage = result.usage || {};

        // Convert to array and sort
        const sites = Object.entries(usage)
            .map(([domain, ms]) => ({
                domain,
                seconds: Math.round(ms / 1000),
                formatted: formatTime(Math.round(ms / 1000))
            }))
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 50); // Top 50

        // Display table
        const container = document.getElementById('usage-table');

        if (sites.length === 0) {
            container.innerHTML = '<div class="no-data">No usage data yet today</div>';
            return;
        }

        let html = '<table><thead><tr><th>Domain</th><th class="time">Time</th></tr></thead><tbody>';

        for (const site of sites) {
            html += `<tr>
      <td>${site.domain}</td>
      <td class="time">${site.formatted}</td>
    </tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (error) {
        console.error('Failed to load usage:', error);
        // Don't show error here, let the state health check handle it
    }
}

// Initialize
loadExportSettings();
loadCurrentSite();
loadUsage();

// Refresh every 5 seconds
setInterval(() => {
    loadCurrentSite();
    loadUsage();
}, 5000);
