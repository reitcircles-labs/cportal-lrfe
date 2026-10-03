/**
 * Sessions that ended before their access tokens expire: a user was suspended, or signed out.
 * Identity publishes `identity.session.revoked` on the event bus; every service keeps what it
 * hears here and refuses the matching tokens (authPlugin) until they would have expired anyway,
 * so the list stays tiny. Normal sign-in, refresh and the idle timeout are not involved.
 *
 * Event data: { userId?, sid?, revokedAt, expiresAt, reason }
 *   userId  every token of that user issued up to revokedAt (suspension)
 *   sid     every token of that session (sign-out)
 *
 * Without a shared bus (EVENT_BUS_DRIVER=log) only identity, which publishes, hears it.
 */
export const SESSION_REVOKED = 'identity.session.revoked';

export function createRevocationList({ events, clock = () => Date.now() } = {}) {
    const byUser = new Map();   // userId → { revokedAt, expiresAt } (ms)
    const bySid = new Map();    // sid → expiresAt (ms)

    function add({ userId, sid, revokedAt, expiresAt } = {}) {
        const until = Date.parse(expiresAt);
        if (!Number.isFinite(until)) return;
        if (sid) bySid.set(sid, Math.max(bySid.get(sid) ?? 0, until));
        if (userId) {
            const at = Date.parse(revokedAt);
            const prev = byUser.get(userId);
            byUser.set(userId, { revokedAt: Math.max(prev?.revokedAt ?? 0, at), expiresAt: Math.max(prev?.expiresAt ?? 0, until) });
        }
    }

    function prune(now) {
        for (const [sid, until] of bySid) if (until <= now) bySid.delete(sid);
        for (const [userId, r] of byUser) if (r.expiresAt <= now) byUser.delete(userId);
    }

    events?.subscribe(SESSION_REVOKED, event => add(event.data));

    return {
        add,
        /** True for an access token (its claims) that a revocation covers. */
        isRevoked(claims) {
            prune(clock());
            if (claims?.sid && bySid.has(claims.sid)) return true;
            const r = claims?.sub && byUser.get(claims.sub);
            // iat is in whole seconds: a token from the same second as the suspension counts as before it
            return !!r && typeof claims.iat === 'number' && claims.iat * 1000 <= r.revokedAt;
        },
        get size() { prune(clock()); return bySid.size + byUser.size; }
    };
}
