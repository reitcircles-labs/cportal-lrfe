import { createEventBus, createRevocationList } from '@lrfe/common';
import { IdentityService } from '../src/identity.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { seedIdentity } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { totp } from '../src/totp.js';

export const PASSWORD = 'correct horse battery staple';
export const JWT_SECRET = 'identity-test-secret-identity-test-secret';

/** A controllable clock: `clock.advance(ms)`. */
export function makeClock(start = Date.parse('2026-09-28T08:00:00Z')) {
    let now = start;
    const clock = () => new Date(now);
    clock.advance = (ms) => { now += ms; };
    return clock;
}

/**
 * Service over a seeded in-memory repo. Demo users all share PASSWORD. MFA policy off unless `mfa`.
 * `clock` defaults to a controllable fake one; pass `() => new Date()` where tokens' real issue
 * times must line up with the service's clock (revocations).
 */
export async function makeService({ mfa = false, clock = makeClock() } = {}) {
    const repo = createMemoryRepo();
    await seedIdentity(repo, { demoPassword: PASSWORD });
    await repo.savePolicies({ mfa, eid: true, ipAllow: false, timeout: 30, fourEyes: true });
    const events = createEventBus({ driver: 'memory', source: 'identity' });
    const published = [];
    events.subscribe('*', e => published.push(e));
    const service = new IdentityService({ repo, events, clock, config: { exposeInviteLinks: true } });
    const user = async (email) => repo.getUserByEmail(email);
    // users (other than administrators) are invited into an office
    const office = await repo.createOffice({ code: 'WDH', name: 'Deeds Registry · Windhoek', type: 'registry' });
    return { repo, service, clock, published, user, office, events };
}

export async function makeApp(opts) {
    const ctx = await makeService(opts);
    const app = await buildApp({
        service: ctx.service, jwtSecret: JWT_SECRET, cookie: { name: 'lrfe_rt', path: '/api/auth', secure: false },
        revocations: createRevocationList({ events: ctx.events })
    });
    await app.ready();

    /** Sign in over HTTP (no MFA) and return { token, cookie, body }. */
    async function login(email, password = PASSWORD) {
        const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
        if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode}: ${res.body}`);
        const cookie = res.cookies.find(c => c.name === 'lrfe_rt');
        return { token: res.json().accessToken, cookie: cookie?.value, body: res.json() };
    }
    const auth = (token) => ({ authorization: `Bearer ${token}` });
    return { ...ctx, app, login, auth };
}

export const codeFor = (secret, clock) => totp(secret, clock().getTime());
