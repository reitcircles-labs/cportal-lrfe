/**
 * Runs before every other test: enrols each demo user's authenticator (MFA is on by default
 * policy) and keeps the secrets for the tests (support/auth.ts).
 */
import { expect, test as setup } from '@playwright/test';
import { ENROLLED_USERS } from '../support/catalogue';
import { codeFor, readSecrets, saveSecrets } from '../support/auth';
import { DEMO_PASSWORD } from '../stack/config.mjs';

setup('enrol the demo users in MFA', async ({ request }) => {
    const previous = readSecrets();
    const secrets: Record<string, string> = {};
    for (const user of ENROLLED_USERS) {
        const res = await request.post('/api/auth/login', { data: { email: user.email, password: DEMO_PASSWORD } });
        expect(res.status(), `${user.email}: ${await res.text()}`).toBe(200);
        const body = await res.json();
        if (body.next === 'mfa') {
            // Enrolled by an earlier run against the same stack (E2E_REUSE=1).
            if (!previous[user.email]) throw new Error(`${user.email} is already enrolled but its secret is unknown: restart the test stack`);
            secrets[user.email] = previous[user.email];
            continue;
        }
        expect(body.next, `${user.email}: MFA is required by the default policy`).toBe('mfa-enroll');
        const done = await request.post('/api/auth/mfa', { data: { challenge: body.challenge, code: codeFor(body.secret) } });
        expect(done.status(), `${user.email}: ${await done.text()}`).toBe(200);
        secrets[user.email] = body.secret;
    }
    saveSecrets(secrets);
});
