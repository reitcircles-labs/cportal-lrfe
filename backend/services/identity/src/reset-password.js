import {hashPassword} from './crypto.js';
import {DEFAULT_SETUP_CODE_TTL_HOURS, issueSetupCode} from './setup-code.js';

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Set a user's password from the command line (scripts/reset-password.js), for when nobody can
 * sign in to do it from the admin screens, e.g. the bootstrap admin's password is lost. The
 * bootstrap only creates the admin, so changing BOOTSTRAP_ADMIN_PASSWORD later changes nothing.
 *
 * Ends the user's sessions and records the reset in the access log. With resetMfa the user's
 * authenticator stops working and they get a one-time setup code (CB-102), with which they set up
 * a new one at the next sign-in: the way back in for an administrator who lost their phone. Status
 * and roles are left as they are.
 *
 * Returns { user, warnings, setupCode? } (the code to print once, with resetMfa) or throws with a
 * message for the operator.
 */
export async function resetPassword(
  repo,
  {
    email,
    password,
    resetMfa = false,
    clock = () => new Date(),
    setupCodeTtlHours = DEFAULT_SETUP_CODE_TTL_HOURS,
  },
) {
  const address = String(email || '')
    .trim()
    .toLowerCase();
  if (!address) throw new Error('An email address is required');
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  const user = await repo.getUserByEmail(address);
  if (!user) throw new Error(`No user with email ${address}`);

  const now = clock();
  const patch = {passwordHash: await hashPassword(password)};
  if (resetMfa) {
    Object.assign(patch, {
      mfaEnrolled: false,
      mfaSecret: null,
      pendingMfaSecret: null,
      mfaLastStep: null,
    });
  }
  let updated = await repo.updateUser(user.id, patch);
  await repo.revokeUserSessions(user.id, now);
  let setupCode;
  if (resetMfa) {
    ({setupCode} = await issueSetupCode(repo, user.id, {
      now,
      ttlHours: setupCodeTtlHours,
    }));
    updated = await repo.getUser(user.id);
  }

  const actor = 'System (command line)';
  await repo.addAccessEvent({
    time: now,
    actorId: null,
    actor,
    kind: 'user',
    action: 'Password reset',
    target: user.name,
    detail: 'Set from the command line; sessions ended',
  });
  if (resetMfa) {
    await repo.addAccessEvent({
      time: now,
      actorId: null,
      actor,
      kind: 'user',
      action: 'MFA reset',
      target: user.name,
      detail: 'Sessions ended; setup code given on the command line',
    });
  }

  const warnings = [];
  if (user.status === 'Suspended') {
    warnings.push(
      'The user is suspended: they cannot sign in until an administrator reactivates them.',
    );
  }
  if (user.status === 'Invited') {
    warnings.push(
      'The user has not accepted their invitation (status Invited) and cannot sign in yet; send a new invitation instead.',
    );
  }
  return {user: updated, warnings, ...(resetMfa ? {setupCode} : {})};
}
