/**
 * Administration helpers: an administrator's API session, users created for one test (invited,
 * activated from their email and enrolled in MFA, all through the API), and the activation link
 * read from the invitation email that identity writes to .stack/mail/.
 *
 * Tests that are about the administration screens do those steps in the browser; these helpers are
 * for tests that only need a fresh user to work with, so they do not share demo users' state.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { apiSignIn, codeFor, rememberSecret } from './auth';
import { userByRole, type RoleId } from './catalogue';
import { MAIL_DIR } from '../stack/config.mjs';

export const NEW_USER_PASSWORD = 'e2e new user password 2026';

/** Unique per call, for names, emails and office codes that must not clash between tests or runs. */
let counter = 0;
export const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A random office code: 2 to 5 capital letters (identity's OFFICE_CODE_PATTERN). */
export const officeCode = () => 'E' + Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

export interface AdminApi { api: APIRequestContext; headers: Record<string, string>; dispose: () => Promise<void>; }

export async function adminApi(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string): Promise<AdminApi> {
    const api = await playwright.request.newContext({ baseURL });
    const token = await apiSignIn(api, userByRole('adm').email);
    return { api, headers: { authorization: `Bearer ${token}` }, dispose: () => api.dispose() };
}

/** Quoted-printable (the encoding of the invitation email's body) to plain text. */
const decodeQuotedPrintable = (s: string) =>
    s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** The activation link from the newest invitation email to `email`; waits up to 10 s for it. */
export async function inviteLink(email: string): Promise<string> {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
        const files = existsSync(MAIL_DIR) ? readdirSync(MAIL_DIR).filter(f => f.endsWith(`-${email}.eml`)).sort() : [];
        if (files.length) {
            const text = decodeQuotedPrintable(readFileSync(join(MAIL_DIR, files[files.length - 1]), 'utf8'));
            const link = text.match(/https?:\/\/[^\s"<]+\/#\/invite\?token=[A-Za-z0-9_-]+/)?.[0];
            if (link) return link;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`No invitation email to ${email} in ${MAIL_DIR}`);
}

/** The path and query of a full app link, for page.goto with the test's base URL. */
export const appPath = (link: string) => link.replace(/^https?:\/\/[^/]+/, '');

export interface NewUser { id: string; name: string; email: string; roles: RoleId[]; }

/** Invite → activate → enrol MFA, all through the API. The user can then sign in like a demo user. */
export async function createUser(admin: AdminApi, roles: RoleId[], label = 'user'): Promise<NewUser> {
    const id = unique();
    const name = `E2E ${label} ${id}`;
    const email = `e2e.${label.toLowerCase().replace(/[^a-z]+/g, '-')}.${id}@deeds.gov.na`;
    const { offices } = await (await admin.api.get('/api/offices', { headers: admin.headers })).json();
    const wdh = offices.find((o: { code: string }) => o.code === 'WDH');
    const res = await admin.api.post('/api/users', { headers: admin.headers, data: { name, email, officeId: wdh.id, roles } });
    expect(res.status(), await res.text()).toBe(201);
    const user = (await res.json()).user;

    const token = new URL(appPath(await inviteLink(email)).replace('/#/', '/'), 'http://x').searchParams.get('token');
    const accepted = await admin.api.post('/api/invitations/accept', { data: { token, password: NEW_USER_PASSWORD } });
    expect(accepted.status(), await accepted.text()).toBe(200);

    const login = await (await admin.api.post('/api/auth/login', { data: { email, password: NEW_USER_PASSWORD } })).json();
    expect(login.next).toBe('mfa-enroll');
    const enrolled = await admin.api.post('/api/auth/mfa', { data: { challenge: login.challenge, code: codeFor(login.secret) } });
    expect(enrolled.status()).toBe(200);
    rememberSecret(email, login.secret);
    return { id: user.id, name, email, roles };
}
