import { getAllUsageForExport } from './common/idb.js';
import { formatTime, formatTimeRemaining } from './common/time.js';

function generateCSV(date, usageData) {
    const data = usageData || {};

    const rows = Object.entries(data)
        .map(([domain, entry]) => {
            let seconds, views, tempAccessCount, firstAccess, lastAccess;
            if (typeof entry === 'number') {
                seconds = Math.round(entry / 1000);
                views = 0;
                tempAccessCount = 0;
                firstAccess = '';
                lastAccess = '';
            } else {
                seconds = Math.round(entry.time / 1000);
                views = entry.views || 0;
                tempAccessCount = entry.tempAccessCount || 0;
                firstAccess = entry.firstAccess ? new Date(entry.firstAccess).toISOString() : '';
                lastAccess = entry.lastAccess ? new Date(entry.lastAccess).toISOString() : '';
            }
            return { domain, seconds, views, tempAccessCount, firstAccess, lastAccess };
        })
        .sort((a, b) => b.seconds - a.seconds);

    let csv = 'date,domain,total_seconds,views,temp_access_count,first_access,last_access\n';
    for (const row of rows) {
        csv += `${date},${row.domain},${row.seconds},${row.views},${row.tempAccessCount},${row.firstAccess},${row.lastAccess}\n`;
    }

    return csv;
}

document.getElementById('download-zip').addEventListener('click', async () => {
    try {
        const allUsage = await getAllUsageForExport();

        if (allUsage.length === 0) {
            showToast('No usage data to export');
            return;
        }

        const zip = new JSZip();

        for (const entry of allUsage) {
            const csv = generateCSV(entry.date, entry.data);
            const filename = `outside-control-usage-${entry.date}.csv`;
            zip.file(filename, csv);
        }

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

async function loadCurrentSite() {
    const response = await chrome.runtime.sendMessage({ action: 'getCurrentSite' });
    const container = document.getElementById('site-info');

    if (!response.host) {
        container.innerHTML = '<p class="no-data">No active site</p>';
        return;
    }

    let html = `<p><strong>${response.host}</strong></p>`;

    if (response.siteInfo) {
        const info = response.siteInfo;

        if (info.sessionRemaining) {
            html += `<p class="status info">Session active: ${formatTimeRemaining(info.sessionRemaining)} remaining</p>`;
        }

        if (info.group === 'hackerNews') {
            if (info.visitsRemaining !== undefined) {
                html += `<p class="status success">${info.visitsRemaining} visits remaining</p>`;
            }
            if (info.resetIn) {
                html += `<p class="status warning">Quota resets in ${formatTimeRemaining(info.resetIn)}</p>`;
            }
        } else if (info.group === 'streaming') {
            html += `<p class="status ${info.status.includes('Blocked') ? 'warning' : 'success'}">${info.status}</p>`;
            if (info.lunchAvailable) {
                html += `<p class="status info">Lunch session available</p>`;
            }
        } else if (info.group === 'social') {
            html += `<p class="status warning">${info.status}</p>`;
        }
    } else {
        html += '<p class="status">Not restricted</p>';
    }

    container.innerHTML = html;
}

async function loadUsage() {
    try {
        const result = await chrome.runtime.sendMessage({ action: 'getUsage' });
        const usage = result.usage || {};

        const sites = Object.entries(usage)
            .map(([domain, data]) => {
                let seconds, views;
                if (typeof data === 'number') {
                    seconds = Math.round(data / 1000);
                    views = 0;
                } else {
                    seconds = Math.round(data.time / 1000);
                    views = data.views || 0;
                }
                return {
                    domain,
                    seconds,
                    views,
                    formatted: formatTime(seconds)
                };
            })
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 50);

        const container = document.getElementById('usage-table');

        if (sites.length === 0) {
            container.innerHTML = '<p class="no-data">No usage data yet today</p>';
            return;
        }

        let html = '<table><thead><tr><th>Domain</th><th class="time">Time</th><th class="views">Views</th></tr></thead><tbody>';

        for (const site of sites) {
            html += `<tr>
                <td>${site.domain}</td>
                <td class="time">${site.formatted}</td>
                <td class="views">${site.views}</td>
            </tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (error) {
        console.error('Failed to load usage:', error);
        container.innerHTML = '<p class="no-data">Error loading usage data</p>';
    }
}

loadCurrentSite();
loadUsage();

// Refresh every 5 seconds
setInterval(() => {
    loadCurrentSite();
    loadUsage();
}, 5000);
