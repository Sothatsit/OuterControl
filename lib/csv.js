export function generateCSV(date, usageData) {
    const data = usageData || {};

    // Convert to array and sort by time (descending)
    const rows = Object.entries(data)
        .map(([domain, ms]) => ({ domain, seconds: Math.round(ms / 1000) }))
        .sort((a, b) => b.seconds - a.seconds);

    let csv = 'date,domain,total_seconds\n';
    for (const row of rows) {
        csv += `${date},${row.domain},${row.seconds}\n`;
    }

    return csv;
}
