/** JSON with object keys sorted at every level, to compare definitions by content. */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
