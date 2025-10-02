const params = new URLSearchParams(window.location.search);
const originalUrl = params.get('url');
const group = params.get('group');
const reason = params.get('reason');
const lunchAvailable = params.get('lunchAvailable') === 'true';
const graceMs = Number(params.get('graceMs')) || 0;

document.getElementById('group-name').textContent = `Blocking Group: ${group}`;
document.getElementById('reason').textContent = reason || 'Access restricted';

const rulesText = document.getElementById('rules-text');
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
      <li>During work hours (Mon-Fri 9am-6pm): 1 hour total allowed per day (timer starts from first access)</li>
      <li>After 1-hour allowance exhausted: blocked for rest of work day</li>
      <li>One 30-minute lunch session available between 12-2pm (if allowance exhausted)</li>
      <li>5-minute grace periods available with code entry</li>
      <li>Unlimited access on weekends and outside work hours (before 9am, after 6pm)</li>
      <li>Includes: YouTube, Disney+, Paramount+, HBO Max, Netflix</li>
    </ul>
  `,
    hackerNews: `
    <ul>
      <li>3 visits allowed every 3 hours</li>
      <li>Each visit limited to 5 minutes</li>
      <li>5-minute grace periods available with code entry</li>
      <li>Applies to: news.ycombinator.com</li>
    </ul>
  `
};
rulesText.innerHTML = rules[group] || '<p>No specific rules defined</p>';

function getHost(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

const host = getHost(originalUrl);

if (group) {
    document.getElementById('grace-section').style.display = 'block';
}

if (lunchAvailable) {
    document.getElementById('lunch-section').style.display = 'block';
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

if (document.getElementById('grace-section').style.display !== 'none') {
    generateCode();
}

document.getElementById('grace-button').addEventListener('click', async () => {
    const input = document.getElementById('code-input').value.toUpperCase();

    if (input !== currentCode) {
        alert('Incorrect code. Try again.');
        generateCode();
        document.getElementById('code-input').value = '';
        return;
    }

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
            durationMs: 30 * 60 * 1000
        });

        if (result.success) {
            window.location.href = originalUrl;
        }
    });
}
