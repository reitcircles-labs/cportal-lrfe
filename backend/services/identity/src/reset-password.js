import { hashPassword } from './crypto.js';

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Set a user's password from the command line (scripts/reset-password.js), for when nobody can
 * sign in to do it from the admin screens, e.g. the bootstrap admin's password is lost. The
 * bootstrap only creates the admin, so changing BOOTSTRAP_ADMIN_PASSWORD later changes nothing.
 *
 * Ends the user's sessions and records the reset in the access log. With resetMfa the user
 * enrols a new authenticator at the next sign-in. Status and roles are left as they are.
 *
 * Returns { user, warnings } or throws with a message for the operator.
 */
export async function resetPassword(repo, { email, password, resetMfa = false, clock = () => new Date() }) {
    const address = String(email || '').trim().toLowerCase();
    if (!address) throw new Error('An email address is required');
    if (String(password || '').length < MIN_PASSWORD_LENGTH) throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    const user = await repo.getUserByEmail(address);
    if (!user) throw new Error(`No user with email ${address}`);

    const now = clock();
    const patch = { passwordHash: await hashPassword(password) };
    if (resetMfa) Object.assign(patch, { mfaEnrolled: false, mfaSecret: null, pendingMfaSecret: null });
    const updated = await repo.updateUser(user.id, patch);
    await repo.revokeUserSessions(user.id, now);

    const actor = 'System (command line)';
    await repo.addAccessEvent({ time: now, actorId: null, actor, kind: 'user', action: 'Password reset', target: user.name, detail: 'Set from the command line; sessions ended' });
    if (resetMfa) await repo.addAccessEvent({ time: now, actorId: null, actor, kind: 'user', action: 'MFA reset', target: user.name, detail: 'Must re-enrol at next sign-in' });

    const warnings = [];
    if (user.status === 'Suspended') warnings.push('The user is suspended: they cannot sign in until an administrator reactivates them.');
    if (user.status === 'Invited') warnings.push('The user has not accepted their invitation (status Invited) and cannot sign in yet; send a new invitation instead.');
    return { user: updated, warnings };
}
