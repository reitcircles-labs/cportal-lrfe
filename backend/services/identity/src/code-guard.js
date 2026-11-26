const MINUTE_MS = 60_000;

/**
 * The limits on guessing authenticator codes (CB-101): wrong codes one sign-in challenge accepts
 * before it is void; wrong codes per user within the window that lock the user's code step, and
 * for how long.
 * @typedef {{
 *   maxWrongCodesPerChallenge: number,
 *   lockoutWrongCodes: number,
 *   lockoutWindowMinutes: number,
 *   lockoutMinutes: number,
 * }} CodeGuardLimits
 */

/** @const {!CodeGuardLimits} */
export const DEFAULT_CODE_GUARD_LIMITS = Object.freeze({
  maxWrongCodesPerChallenge: 5,
  lockoutWrongCodes: 10,
  lockoutWindowMinutes: 15,
  lockoutMinutes: 15,
});

/**
 * Counts wrong authenticator codes per sign-in challenge and per user, in this process's memory (a
 * restart clears the counts). The count per user takes every code check of the user (enrolment and
 * sign-in; setup codes later), whatever address sent it.
 *
 * Every method is synchronous: a caller that checks, verifies the code and records the result
 * without awaiting in between cannot be overtaken by simultaneous guesses.
 */
export class CodeGuard {
  /**
   * @param {{clock: function(): !Date, limits: (!CodeGuardLimits|undefined)}} options
   */
  constructor({clock, limits = DEFAULT_CODE_GUARD_LIMITS}) {
    this.clock = clock;
    this.limits = {...DEFAULT_CODE_GUARD_LIMITS, ...limits};
    /** @type {!Map<string, {wrong: number, expiresAt: number}>} wrong codes per open challenge */
    this.challenges = new Map();
    /** @type {!Map<string, !Array<number>>} times of each user's recent wrong codes */
    this.wrongTimes = new Map();
    /** @type {!Map<string, number>} until when each locked user's code step is locked */
    this.lockedUntil = new Map();
  }

  /**
   * Whether a code may be checked now for `userId` on `challenge`: null when it may; otherwise
   * why not, `locked` with the whole minutes left, or `void` when the challenge used up its wrong
   * codes.
   * Without a challenge only the user's lock applies.
   * @param {string} userId
   * @param {{id: string, expiresAt: number}=} challenge
   * @return {?{reason: string, minutesLeft: (number|undefined)}}
   */
  refusal(userId, challenge) {
    const now = this.clock().getTime();
    this.forgetExpired(now);
    const until = this.lockedUntil.get(userId);
    if (until !== undefined) {
      return {
        reason: 'locked',
        minutesLeft: Math.ceil((until - now) / MINUTE_MS),
      };
    }
    if (!challenge) {
      return null;
    }
    const wrong = this.challenges.get(challenge.id)?.wrong ?? 0;
    if (wrong >= this.limits.maxWrongCodesPerChallenge) {
      return {reason: 'void'};
    }
    return null;
  }

  /**
   * Counts a wrong code for `userId`, and on `challenge` when there is one.
   * @param {string} userId
   * @param {{id: string, expiresAt: number}=} challenge
   * @return {boolean} whether this code locked the user (true once per lockout)
   */
  recordWrong(userId, challenge) {
    const now = this.clock().getTime();
    if (challenge) {
      const entry = this.challenges.get(challenge.id) ?? {
        wrong: 0,
        expiresAt: challenge.expiresAt,
      };
      entry.wrong++;
      this.challenges.set(challenge.id, entry);
    }

    const windowStart = now - this.limits.lockoutWindowMinutes * MINUTE_MS;
    const times = (this.wrongTimes.get(userId) ?? []).filter(
      time => time > windowStart,
    );
    times.push(now);
    if (times.length < this.limits.lockoutWrongCodes) {
      this.wrongTimes.set(userId, times);
      return false;
    }
    this.wrongTimes.delete(userId);
    this.lockedUntil.set(userId, now + this.limits.lockoutMinutes * MINUTE_MS);
    return true;
  }

  /**
   * A right code: the user's count of wrong codes starts again.
   * @param {string} userId
   */
  recordSuccess(userId) {
    this.wrongTimes.delete(userId);
  }

  /**
   * Drops the counts that no longer matter: ended locks, expired challenges, users whose wrong
   * codes are all older than the window.
   * @param {number} now
   */
  forgetExpired(now) {
    for (const [userId, until] of this.lockedUntil) {
      if (until <= now) {
        this.lockedUntil.delete(userId);
      }
    }
    for (const [id, entry] of this.challenges) {
      if (entry.expiresAt <= now) {
        this.challenges.delete(id);
      }
    }
    const windowStart = now - this.limits.lockoutWindowMinutes * MINUTE_MS;
    for (const [userId, times] of this.wrongTimes) {
      if (times.at(-1) <= windowStart) {
        this.wrongTimes.delete(userId);
      }
    }
  }
}
