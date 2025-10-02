// Build a domain lookup map from policies for faster lookups
export function buildDomainMap(policies) {
    const map = new Map();
    for (const [group, config] of Object.entries(policies)) {
        for (const domain of config.hosts) {
            map.set(domain, { group, config });
        }
    }
    return map;
}

export function lookupGroup(host, domainMap) {
    if (domainMap.has(host)) {
        return domainMap.get(host);
    }

    // Try subdomain matching (e.g., www.reddit.com matches reddit.com)
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join('.');
        if (domainMap.has(suffix)) {
            return domainMap.get(suffix);
        }
    }

    return null;
}
