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

/** The organisation's texts when a setting is not set at all (the first site's). */
export const DEFAULT_ORG = Object.freeze({
    name: 'Deeds Registry',
    subtitle: 'Republic of Namibia',
    parent: 'Ministry of Agriculture, Fisheries, Water and Land Reform',
    place: 'Windhoek'
});

/** The one-line form of the default organisation, for emails and the authenticator app. */
export const DEFAULT_ORG_FULL_NAME = `${DEFAULT_ORG.name} · ${DEFAULT_ORG.subtitle}`;

/**
 * The organisation running the portal, from the site's settings (API-712): LRFE_ORG_NAME,
 * LRFE_ORG_SUBTITLE, LRFE_ORG_PARENT, LRFE_ORG_PLACE, the same ones the web app shows
 * (angular-app/src/app/state/site-config.ts). Unlike env(), a setting that is set but empty stays
 * empty (not shown); only one that is not set at all gets the default. The name is never empty.
 * `fullName` is the one-line form for emails and the authenticator app: "Deeds Registry · Republic
 * of Namibia", or only the name without a subtitle.
 */
export function orgFromEnv(source = process.env) {
    const read = (name, fallback) => (source[name] === undefined ? fallback : source[name].trim());
    const org = {
        name: read('LRFE_ORG_NAME', DEFAULT_ORG.name) || DEFAULT_ORG.name,
        subtitle: read('LRFE_ORG_SUBTITLE', DEFAULT_ORG.subtitle),
        parent: read('LRFE_ORG_PARENT', DEFAULT_ORG.parent),
        place: read('LRFE_ORG_PLACE', DEFAULT_ORG.place)
    };
    return { ...org, fullName: org.subtitle ? `${org.name} · ${org.subtitle}` : org.name };
}
