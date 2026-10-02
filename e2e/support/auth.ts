/**
 * Signing in during tests. Every demo user's authenticator is enrolled once by tests/auth.setup.ts,
 * which keeps the secrets in .auth/totp.json; the tests then compute the 6-digit code the way an
 * authenticator app does.
 *
 * Browser sessions cannot be saved and reused between tests (Playwright's storageState): the
 * refresh token rotates on every use and the server revokes a session whose old token comes back.
 * So each test signs in through the API, which is fast, and the sign-in screen itself is covered
 * by sign-in.spec.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { totp } from '../../backend/services/identity/src/totp.js';
import { DEMO_PASSWORD, E2E_DIR } from '../stack/config.mjs';

const SECRETS_FILE = join(E2E_DIR, '.auth', 'totp.json');

export const readSecrets = (): Record<string, string> =>
    existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) : {};

export function saveSecrets(secrets: Record<string, string>) {
    mkdirSync(dirname(SECRETS_FILE), { recursive: true });
    writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

export const codeFor = (secret: string) => totp(secret);

export function secretOf(email: string): string {
    const secret = readSecrets()[email];
    if (!secret) throw new Error(`No authenticator secret for ${email}: the setup project (auth.setup.ts) enrols the demo users first`);
    return secret;
}

/** Password + authenticator code through the API. Returns the access token; the refresh cookie lands in `request`'s cookie jar. */
export async function apiSignIn(request: APIRequestContext, email: string, password = DEMO_PASSWORD): Promise<string> {
    const step1 = await request.post('/api/auth/login', { data: { email, password } });
    expect(step1.status(), `sign-in of ${email}: ${await step1.text()}`).toBe(200);
    const body = await step1.json();
    if (body.accessToken) return body.accessToken;
    expect(body.next, `${email} should already be enrolled (auth.setup.ts)`).toBe('mfa');
    const step2 = await request.post('/api/auth/mfa', { data: { challenge: body.challenge, code: codeFor(secretOf(email)) } });
    expect(step2.status(), `authenticator code of ${email}: ${await step2.text()}`).toBe(200);
    return (await step2.json()).accessToken;
}

/** Sign `page`'s browser in as `email` and open `path` (default: that user's home). */
export async function signInAs(page: Page, email: string, path = '/') {
    await apiSignIn(page.request, email);
    await page.goto(`/#${path}`);
    await expect(page.locator('aside.sidebar')).toBeVisible();
}
