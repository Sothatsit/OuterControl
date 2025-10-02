import { getAllUsageForExport } from './lib/idb.js';
import { generateCSV } from './lib/csv.js';
import { formatTime, formatTimeRemaining } from './lib/time.js';

// Download ZIP with all usage data
document.getElementById('download-zip').addEventListener('click', async () => {
    try {
        // Get all usage data from IndexedDB
        const allUsage = await getAllUsageForExport();

        if (allUsage.length === 0) {
            showToast('No usage data to export');
            return;
        }

        // Create ZIP file
        const zip = new JSZip();

        for (const entry of allUsage) {
            const csv = generateCSV(entry.date, entry.data);
            const filename = `outside-control-usage-${entry.date}.csv`;
            zip.file(filename, csv);
        }

        // Generate and download ZIP
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);

        await chrome.downloads.download({
            url: url,
            filename: 'outside-control-usage.zip',
            saveAs: true
        });

        showToast(`Exported ${allUsage.length} days of usage data`);

        // Clean up object URL after a short delay
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        console.error('Failed to export ZIP:', e);
        showToast('Export failed: ' + e.message);
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
    }
}

// Initialize
loadCurrentSite();
loadUsage();

// Refresh every 5 seconds
setInterval(() => {
    loadCurrentSite();
    loadUsage();
}, 5000);
