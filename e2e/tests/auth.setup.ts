/**
 * Runs before every other test: checks that each demo user signs in with the authenticator the
 * stack's seeding set up (CB-102: the password alone never sets one up), and keeps the secrets for
 * the tests (support/auth.ts).
 */
import {expect, test as setup} from '@playwright/test';
import {ENROLLED_USERS} from '../support/catalogue';
import {codeFor, demoSecretOf, saveSecrets} from '../support/auth';
import {DEMO_PASSWORD} from '../stack/config.mjs';

setup('the demo users sign in with their authenticators', async ({request}) => {
  const secrets: Record<string, string> = {};
  for (const user of ENROLLED_USERS) {
    const res = await request.post('/api/auth/login', {
      data: {email: user.email, password: DEMO_PASSWORD},
    });
    expect(res.status(), `${user.email}: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(
      body.next,
      `${user.email}: the stack's seeding sets up the authenticator`,
    ).toBe('mfa');
    const secret = demoSecretOf(user.email);
    const done = await request.post('/api/auth/mfa', {
      data: {challenge: body.challenge, code: codeFor(secret)},
    });
    expect(done.status(), `${user.email}: ${await done.text()}`).toBe(200);
    secrets[user.email] = secret;
  }
  saveSecrets(secrets);
});
