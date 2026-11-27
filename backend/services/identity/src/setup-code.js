import {randomInt} from 'node:crypto';
import {mkdir, open} from 'node:fs/promises';
import {dirname} from 'node:path';
import {sha256} from './crypto.js';

/**
 * One-time setup codes (CB-102): an administrator gives one to a user who has no authenticator,
 * and only with it does the sign-in show the authenticator's QR code. Shown as XXXX-XXXX, from an
 * alphabet without characters that look alike (no 0/O, 1/I/L). Stored only as a hash.
 */

/** The characters of a setup code: capital letters and digits, without look-alikes. */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** The length of a setup code, without its dash. */
const SETUP_CODE_LENGTH = 8;

/** A setup code as typed, once normalised: exactly the code's characters. */
const NORMALISED_CODE = new RegExp(
  `^[${SETUP_CODE_ALPHABET}]{${SETUP_CODE_LENGTH}}$`,
);

/**
 * A new random setup code, as the administrator is shown it.
 * @return {string} e.g. "K7QM-2XPD"
 */
export function generateSetupCode() {
  let code = '';
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) {
    code += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A setup code as the user typed it, in the form it is hashed in: capitals, without the dash or
 * spaces ("abcd2345" and "ABCD-2345" are the same code). Null when it cannot be a setup code.
 * @param {*} typed
 * @return {?string}
 */
export function normaliseSetupCode(typed) {
  if (typeof typed !== 'string') {
    return null;
  }
  const normalised = typed.toUpperCase().replace(/[\s-]/g, '');
  return NORMALISED_CODE.test(normalised) ? normalised : null;
}

/**
 * The stored form of a user's setup code: a hash bound to the user, so one user's code never
 * matches another's.
 * @param {string} userId
 * @param {string} normalised the code, as normaliseSetupCode returns it
 * @return {string}
 */
export function setupCodeHash(userId, normalised) {
  return sha256(`setup-code:${userId}:${normalised}`);
}

/** How long a setup code works when the site sets nothing, in hours. */
export const DEFAULT_SETUP_CODE_TTL_HOURS = 72;

/**
 * Gives `userId` a new one-time setup code: stores only its hash and expiry, replacing any earlier
 * code and any authenticator secret shown before. Used by the administrator's screens, the seed
 * (the first administrator, the demo users) and the command-line reset.
 * @param {!Object} repo the identity repository
 * @param {string} userId
 * @param {{now: !Date, ttlHours: number}} options
 * @return {!Promise<{setupCode: string, expiresAt: !Date}>} the code, to show once
 */
export async function issueSetupCode(repo, userId, {now, ttlHours}) {
  const setupCode = generateSetupCode();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  await repo.updateUser(userId, {
    setupCodeHash: setupCodeHash(userId, normaliseSetupCode(setupCode)),
    setupCodeExpiresAt: expiresAt,
    pendingMfaSecret: null,
  });
  return {setupCode, expiresAt};
}

/**
 * The line an operator reads for a setup code: in identity's setup-code file for the first
 * administrator and the demo users, on the terminal of the command-line reset. Never in a log.
 * @param {string} email
 * @param {string} setupCode
 * @param {number} ttlHours
 * @return {string}
 */
export function setupCodeLine(email, setupCode, ttlHours) {
  return (
    `Setup code for ${email}: ${setupCode} (sets up the authenticator at the next sign-in; ` +
    `one use, valid for ${ttlHours} hours)`
  );
}

/**
 * Adds `lines` to the setup-code file (CB-102, design decision 9): identity's setup codes given at
 * start go there, never to its console or log. The file and a folder it creates are readable only
 * by identity's user; a file that was there already is made so too.
 * @param {string} file the path (SETUP_CODE_FILE)
 * @param {!Array<string>} lines
 * @return {!Promise<void>}
 */
export async function appendSetupCodeFile(file, lines) {
  await mkdir(dirname(file), {recursive: true, mode: 0o700});
  const handle = await open(file, 'a', 0o600);
  try {
    // A file that was there already is made private before a code is written into it.
    await handle.chmod(0o600);
    await handle.appendFile(lines.map(line => `${line}\n`).join(''));
  } finally {
    await handle.close();
  }
}
