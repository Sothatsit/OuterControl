const params = new URLSearchParams(window.location.search);
const originalUrl = params.get('url');

let group = null;
let reason = null;
let lunchAvailable = false;
let lunchCount = 0;
let maxLunchSessions = 0;
let graceMs = 0;
let host = null;

function getHost(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

host = getHost(originalUrl);

function formatDuration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

async function loadBlockingInfo() {
    const response = await chrome.runtime.sendMessage({
        action: 'checkAccess',
        host: host
    });

    if (response.allow) {
        // Not blocked anymore, redirect back
        window.location.href = originalUrl;
        return;
    }

    group = response.group;
    reason = response.reason || 'Access restricted';
    lunchAvailable = response.lunchAvailable || false;
    lunchCount = response.lunchCount || 0;
    maxLunchSessions = response.maxLunchSessions || 0;
    graceMs = response.graceDurationMs || 0;

    document.getElementById('group-name').textContent = `Blocking Group: ${group}`;
    document.getElementById('reason').textContent = reason;

    const rulesText = document.getElementById('rules-text');
    rulesText.innerHTML = rules[group] || '<p>No specific rules defined</p>';

    if (group && graceMs > 0) {
        document.getElementById('grace-section').style.display = 'block';
        const graceButton = document.getElementById('grace-button');
        graceButton.textContent = `Unlock for ${formatDuration(graceMs)}`;
        generateCode();
    }

    if (group === 'streaming' && maxLunchSessions > 0) {
        document.getElementById('lunch-count').textContent = `Lunch sessions used: ${lunchCount}/${maxLunchSessions}`;
        document.getElementById('lunch-count').style.display = 'block';
    }

    if (lunchAvailable) {
        document.getElementById('lunch-section').style.display = 'block';
    }

    await loadTempAccessCount();
}

const rules = {
    social: `
    <ul>
      <li>Blocked 24/7</li>
      <li>5-minute grace periods available with code entry</li>
      <li>Includes: Reddit, Twitter/X</li>
    </ul>
  `,
    streaming: `
    <ul>
      <li>During work hours (Mon-Fri 9am-5pm): 1 hour total allowed per day (timer starts from first access)</li>
      <li>After 1-hour allowance exhausted: blocked for rest of work day</li>
      <li>Three 45-minute lunch sessions available between 11am-3pm (if allowance exhausted)</li>
      <li>5-minute grace periods available with code entry during work hours</li>
      <li>Evening hours (9pm-2am): blocked, but 30-minute sessions available with code entry</li>
      <li>Unlimited access on weekends and outside restricted hours (5pm-9pm, 2am-9am)</li>
      <li>Includes: YouTube, Disney+, Paramount+, HBO Max, Netflix</li>
    </ul>
  `,
    hackerNews: `
    <ul>
      <li>Blocked during work hours (Mon-Fri 9am-5pm)</li>
      <li>Blocked during evening hours (9pm-2am)</li>
      <li>5-minute grace periods available with code entry</li>
      <li>Unlimited access outside restricted hours</li>
      <li>Applies to: news.ycombinator.com</li>
    </ul>
  `
};

loadBlockingInfo().catch(err => console.error('Failed to load blocking info:', err));

async function loadTempAccessCount() {
    try {
        const result = await chrome.runtime.sendMessage({ action: 'getUsage' });
        const usage = result.usage || {};
        const hostData = usage[host];
        let count = 0;

        if (hostData) {
            if (typeof hostData === 'object' && hostData.tempAccessCount !== undefined) {
                count = hostData.tempAccessCount;
            }
        }

        const countElem = document.getElementById('temp-access-count');
        if (count === 0) {
            countElem.textContent = `You have not requested temporary access for ${host} today.`;
        } else if (count === 1) {
            countElem.textContent = `You have requested 1 temporary access for ${host} today.`;
        } else {
            countElem.textContent = `You have requested ${count} temporary accesses for ${host} today.`;
        }
    } catch (error) {
        console.error('Failed to load temp access count:', error);
    }
}

let currentCode = '';

function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let newCode = '';
    for (let i = 0; i < 16; i++) {
        newCode += chars[Math.floor(Math.random() * chars.length)];
    }
    currentCode = newCode;

    const canvas = document.getElementById('code-canvas');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = 50;

    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '24px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(currentCode, canvas.width / 2, canvas.height / 2);
}

document.getElementById('grace-button').addEventListener('click', async () => {
    const input = document.getElementById('code-input').value.toUpperCase();

    if (input !== currentCode) {
        alert('Incorrect code. Try again.');
        generateCode();
        document.getElementById('code-input').value = '';
        return;
    }

    await chrome.runtime.sendMessage({
        action: 'recordTempAccess',
        host: host
    });

    const result = await chrome.runtime.sendMessage({
        action: 'startSession',
        host: host,
        type: 'grace',
        durationMs: graceMs
    });

    if (result.success) {
        window.location.href = originalUrl;
    }
});

if (document.getElementById('lunch-button')) {
    document.getElementById('lunch-button').addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({
            action: 'startSession',
            host: host,
            type: 'lunch',
            durationMs: 45 * 60 * 1000
        });

        if (result.success) {
            window.location.href = originalUrl;
        }
    });
}
