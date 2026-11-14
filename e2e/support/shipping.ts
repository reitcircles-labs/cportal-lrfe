/**
 * Helpers of the shipping product's API specs (tests-shipping/): signing a user in through the
 * gateway, and an organisation with a B/L clerk of its own, made by the administrator through the
 * API (CB-34).
 *
 * The shipping run has no setup project: a user enrols the authenticator on their first sign-in,
 * and the secret is kept in .auth/totp.json (support/auth.ts) so that a later spec signs the same
 * user in again. The shipping run has one worker, so the file is never written twice at once.
 */
import {createHmac} from 'node:crypto';
import {expect, type APIRequestContext} from '@playwright/test';
import {appPath, invitationEmail, officeCode, unique} from './admin';
import {codeFor, readSecrets, saveSecrets} from './auth';
import {identity} from '../../backend/domains/shipping/src/identity.js';
import {DEMO_PASSWORD, JWT_SECRET} from '../stack/config.mjs';

/** A demo user of the shipping pack, as far as the specs read it. */
interface DemoUser {
  email: string;
  roles: string[];
}

/** The demo users of the shipping pack's identity section (its JSDoc type is not read here). */
const DEMO_USERS: DemoUser[] = (identity as {demoUsers: DemoUser[]}).demoUsers;

/**
 * The email of the shipping pack's demo users with a role, in the pack's order.
 * @param role the role id
 * @return their emails
 */
export function demoEmails(role: string): string[] {
  return DEMO_USERS.filter(u => u.roles.includes(role)).map(u => u.email);
}

/** The password of the users the specs invite. */
const INVITED_PASSWORD = 'e2e shipping user password 2026';

/** A signed-in user: who they are and the header with their access token. */
export interface SignedIn {
  id: string;
  name: string;
  email: string;
  organisationId: string;
  headers: Record<string, string>;
}

/** An organisation made for a spec, with its clerk signed in. */
export interface Organisation {
  id: string;
  code: string;
  name: string;
  clerk: SignedIn;
}

/**
 * A service token as the services sign it (HS256 with the shared secret), as page-text.spec.ts
 * makes one.
 * @param service the service's name
 * @return the token
 */
export function serviceToken(service: string): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({alg: 'HS256', typ: 'JWT'});
  const claims = b64({typ: 'service', sub: service, iat: now, exp: now + 300});
  const data = `${header}.${claims}`;
  const signature = createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${signature}`;
}

/**
 * Signs a user in through the API: password, then the authenticator, enrolling it on the first
 * sign-in of a fresh stack and keeping its secret for later sign-ins.
 * @param api the request context, on the gateway
 * @param email the user's email
 * @param password the user's password (the demo password by default)
 * @return the signed-in user
 */
export async function signIn(
  api: APIRequestContext,
  email: string,
  password = DEMO_PASSWORD,
): Promise<SignedIn> {
  const login = await api.post('/api/auth/login', {data: {email, password}});
  expect(login.status(), `sign-in of ${email}: ${await login.text()}`).toBe(
    200,
  );
  const first = await login.json();
  let secret: string;
  if (first.next === 'mfa-enroll') {
    secret = first.secret;
    saveSecrets({...readSecrets(), [email]: secret});
  } else {
    expect(first.next, `sign-in of ${email}`).toBe('mfa');
    secret = readSecrets()[email];
    expect(secret, `the authenticator secret of ${email}`).toBeTruthy();
  }
  const mfa = await api.post('/api/auth/mfa', {
    data: {challenge: first.challenge, code: codeFor(secret)},
  });
  expect(mfa.status(), `authenticator of ${email}: ${await mfa.text()}`).toBe(
    200,
  );
  const {accessToken, me} = await mfa.json();
  return {
    id: me.user.id,
    name: me.user.name,
    email,
    organisationId: me.user.organisationId,
    headers: {authorization: `Bearer ${accessToken}`},
  };
}

/**
 * A new organisation with one office and one user of the given role, invited, activated and
 * signed in, all through the API as the administrator.
 * @param api the request context, on the gateway
 * @param admin the signed-in administrator
 * @param label a word for the names, e.g. "Bank"
 * @param role the user's role (the B/L clerk's by default)
 * @return the organisation and its signed-in clerk
 */
export async function organisationWithClerk(
  api: APIRequestContext,
  admin: SignedIn,
  label: string,
  role = 'bld',
): Promise<Organisation> {
  const id = unique();
  const created = await api.post('/api/organisations', {
    headers: admin.headers,
    data: {code: officeCode(), name: `E2E ${label} ${id}`},
  });
  expect(created.status(), await created.text()).toBe(201);
  const organisation = await created.json();

  const office = await api.post('/api/offices', {
    headers: admin.headers,
    data: {
      code: officeCode(),
      name: `${label} office ${id}`,
      type: 'external',
      organisationId: organisation.id,
    },
  });
  expect(office.status(), await office.text()).toBe(201);
  const officeId = (await office.json()).id;

  const email = `e2e.${label.toLowerCase()}.${id}@shipping.example`;
  const invited = await api.post('/api/users', {
    headers: admin.headers,
    data: {
      name: `${label} clerk ${id}`,
      email,
      officeId,
      organisationId: organisation.id,
      roles: [role],
    },
  });
  expect(invited.status(), await invited.text()).toBe(201);
  const token = new URL(
    appPath((await invitationEmail(email)).link).replace('/#/', '/'),
    'http://x',
  ).searchParams.get('token');
  const accepted = await api.post('/api/invitations/accept', {
    data: {token, password: INVITED_PASSWORD},
  });
  expect(accepted.status(), await accepted.text()).toBe(200);

  const clerk = await signIn(api, email, INVITED_PASSWORD);
  expect(clerk.organisationId).toBe(organisation.id);
  return {
    id: organisation.id,
    code: organisation.code,
    name: organisation.name,
    clerk,
  };
}
