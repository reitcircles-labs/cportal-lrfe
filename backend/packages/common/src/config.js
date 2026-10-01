import dotenv from 'dotenv';

dotenv.config();

/** Read a required env var, or return `fallback` when it is unset. Throws if unset and no fallback given. */
export function env(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value === '') {
        if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
        return fallback;
    }
    return value;
}

export function envInt(name, fallback) {
    const raw = env(name, fallback === undefined ? undefined : String(fallback));
    const value = Number.parseInt(raw, 10);
    if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
    return value;
}

export function envBool(name, fallback) {
    const raw = env(name, fallback === undefined ? undefined : String(fallback));
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/** An env var restricted to known values, e.g. envOneOf('EDRMS_STORE', ['postgres', 'memory'], 'postgres'). */
export function envOneOf(name, allowed, fallback) {
    const value = env(name, fallback);
    if (!allowed.includes(value)) {
        const shown = /:\/\//.test(value) ? '(a URL — did you mean DB_CONNECTION_STRING?)' : `"${value}"`;
        throw new Error(`${name} must be one of ${allowed.join(' | ')}, got ${shown}`);
    }
    return value;
}

export function envList(name, fallback = '') {
    return env(name, fallback).split(',').map(s => s.trim()).filter(Boolean);
}
