/**
 * Signing in during tests. Every demo user starts with an authenticator set up by the stack's
 * seeding (CB-102: SEED_DEMO_MFA_KEY), its secret derived from a key the tests share
 * (demoSecretOf); tests/auth.setup.ts checks them and keeps the secrets in .auth/totp.json. The
 * tests then compute the 6-digit code the way an authenticator app does.
 *
 * Browser sessions cannot be saved and reused between tests (Playwright's storageState): the
 * refresh token rotates on every use and the server revokes a session whose old token comes back.
 * So each test signs in through the API, which is fast, and the sign-in screen itself is covered
 * by sign-in.spec.ts.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import {demoMfaSecret} from '../../backend/services/identity/src/seed.js';
import {totp} from '../../backend/services/identity/src/totp.js';
import {DEMO_MFA_KEY, DEMO_PASSWORD, E2E_DIR} from '../stack/config.mjs';

const SECRETS_FILE = join(E2E_DIR, '.auth', 'totp.json');

export const readSecrets = (): Record<string, string> =>
  existsSync(SECRETS_FILE)
    ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8'))
    : {};

export function saveSecrets(secrets: Record<string, string>) {
  mkdirSync(dirname(SECRETS_FILE), {recursive: true});
  writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

export const codeFor = (secret: string) => totp(secret);

/**
 * The authenticator secret the stack's seeding gave a demo user (CB-102).
 * @param email the demo user's email
 * @return the secret
 */
export function demoSecretOf(email: string): string {
  return demoMfaSecret(DEMO_MFA_KEY, email);
}

/**
 * A 6-digit code that is wrong for `secret` now: none of the codes the server accepts (the current
 * one and one step of clock drift either side).
 */
export function wrongCodeFor(secret: string): string {
  const now = Date.now();
  const accepted = new Set(
    [-30_000, 0, 30_000].map(drift => totp(secret, now + drift)),
  );
  for (const candidate of ['000000', '111111', '222222', '333333']) {
    if (!accepted.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('unreachable: at most three codes are accepted');
}

/** Users created during a test (support/admin.ts) enrol in that test's worker; their secrets live here. */
const created = new Map<string, string>();
export const rememberSecret = (email: string, secret: string) =>
  created.set(email, secret);

export function secretOf(email: string): string {
  const secret = created.get(email) ?? readSecrets()[email];
  if (!secret) {
    throw new Error(
      `No authenticator secret for ${email}: the setup project (auth.setup.ts) checks the demo users first`,
    );
  }
  return secret;
}

/** Password + authenticator code through the API. Returns the access token; the refresh cookie lands in `request`'s cookie jar. */
export async function apiSignIn(
  request: APIRequestContext,
  email: string,
  password = DEMO_PASSWORD,
): Promise<string> {
  const step1 = await request.post('/api/auth/login', {
    data: {email, password},
  });
  expect(step1.status(), `sign-in of ${email}: ${await step1.text()}`).toBe(
    200,
  );
  const body = await step1.json();
  if (body.accessToken) return body.accessToken;
  expect(body.next, `${email} should already be enrolled (auth.setup.ts)`).toBe(
    'mfa',
  );
  const step2 = await request.post('/api/auth/mfa', {
    data: {challenge: body.challenge, code: codeFor(secretOf(email))},
  });
  expect(
    step2.status(),
    `authenticator code of ${email}: ${await step2.text()}`,
  ).toBe(200);
  return (await step2.json()).accessToken;
}

/** Sign `page`'s browser in as `email` and open `path`. */
export async function signInAs(
  page: Page,
  email: string,
  path = '/',
  password = DEMO_PASSWORD,
) {
  await apiSignIn(page.request, email, password);
  await page.goto(`/#${path}`);
  await expect(page.locator('aside.sidebar')).toBeVisible();
}

/**
 * A person in their own browser context (so several people can work at once), signed in and on
 * `path`. The window is wider than the default so wide tables show their buttons in screenshots.
 */
export async function signedInPage(
  browser: Browser,
  email: string,
  path: string,
  password?: string,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: {width: 1600, height: 1000},
  });
  const page = await context.newPage();
  await signInAs(page, email, path, password);
  return page;
}
