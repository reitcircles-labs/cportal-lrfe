import {expect} from 'chai';
import {makeApp, codeFor, wrongCodeFor, PASSWORD} from './helpers.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {demoMfaSecret, seedIdentity} from '../src/seed.js';

/**
 * CB-104, test-only exemption: the end-to-end tests sign the same demo users in from parallel
 * workers within one time step. A demo user whose authenticator was seeded through the test-only
 * key (SEED_DEMO_MFA_KEY, refused unless NODE_ENV=test: see start-up.test.js) may reuse a code;
 * the rest of the code check is unchanged. Without the key, and for any user who set up an
 * authenticator the normal way, a code is accepted once.
 */

const KEY = 'a test key';
const SCAN = 'k.iipinge@deeds.gov.na';
const ADMIN = 'p.hamutenya@deeds.gov.na';

/**
 * The identity app over a store seeded with the demo authenticators of `KEY`; the service is given
 * `demoMfaKey` (as identity is when SEED_DEMO_MFA_KEY is set).
 * @param {(string|undefined)} demoMfaKey
 * @return {!Promise<!Object>}
 */
async function seededApp(demoMfaKey) {
  const repo = createMemoryRepo();
  await seedIdentity(repo, {demoPassword: PASSWORD, demoMfaKey: KEY});
  const ctx = await makeApp({repo, mfa: true, config: {demoMfaKey}});

  /** `code` on a fresh challenge of `email`. */
  async function signIn(email, code) {
    const step1 = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {email, password: PASSWORD},
    });
    expect(step1.statusCode, step1.body).to.equal(200);
    return ctx.app.inject({
      method: 'POST',
      url: '/auth/mfa',
      payload: {challenge: step1.json().challenge, code},
    });
  }
  return {...ctx, signIn};
}

describe('test-only: demo users seeded through the end-to-end key may reuse a code (CB-104)', () => {
  it('with the key, a seeded demo user signs in twice with the same code', async () => {
    const t = await seededApp(KEY);
    const code = codeFor(demoMfaSecret(KEY, SCAN), t.clock);
    expect((await t.signIn(SCAN, code)).statusCode).to.equal(200);
    expect((await t.signIn(SCAN, code)).statusCode).to.equal(200);
  });

  it('with the key, a seeded demo user is still refused a wrong code', async () => {
    const t = await seededApp(KEY);
    const res = await t.signIn(
      SCAN,
      wrongCodeFor(demoMfaSecret(KEY, SCAN), t.clock),
    );
    expect(res.statusCode).to.equal(401);
    expect(res.json().message).to.equal('Invalid authenticator code');
  });

  it('without the key, the same seeded secret is accepted once', async () => {
    const t = await seededApp(undefined);
    const code = codeFor(demoMfaSecret(KEY, SCAN), t.clock);
    expect((await t.signIn(SCAN, code)).statusCode).to.equal(200);
    const again = await t.signIn(SCAN, code);
    expect(again.statusCode).to.equal(401);
    expect(again.json().message).to.equal('Invalid authenticator code');
  });

  it('with the key, a user who set up an authenticator the normal way is accepted once', async () => {
    const t = await seededApp(KEY);
    const admin = await t.signIn(
      ADMIN,
      codeFor(demoMfaSecret(KEY, ADMIN), t.clock),
    );
    expect(admin.statusCode, admin.body).to.equal(200);
    const scanId = (await t.repo.getUserByEmail(SCAN)).id;
    const reset = await t.app.inject({
      method: 'POST',
      url: `/users/${scanId}/mfa-reset`,
      headers: t.auth(admin.json().accessToken),
    });
    expect(reset.statusCode, reset.body).to.equal(200);
    const step1 = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {email: SCAN, password: PASSWORD},
    });
    const setup = await t.app.inject({
      method: 'POST',
      url: '/auth/setup-code',
      payload: {
        challenge: step1.json().challenge,
        setupCode: reset.json().setupCode,
      },
    });
    expect(setup.statusCode, setup.body).to.equal(200);
    const {challenge, secret} = setup.json();
    const code = codeFor(secret, t.clock);
    const enrolled = await t.app.inject({
      method: 'POST',
      url: '/auth/mfa',
      payload: {challenge, code},
    });
    expect(enrolled.statusCode, enrolled.body).to.equal(200);
    const again = await t.signIn(SCAN, code);
    expect(again.statusCode).to.equal(401);
    expect(again.json().message).to.equal('Invalid authenticator code');
  });
});
