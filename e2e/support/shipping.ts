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
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, type APIRequestContext, type Page} from '@playwright/test';
import {appPath, invitationEmail, officeCode, unique} from './admin';
import {codeFor, readSecrets, saveSecrets} from './auth';
import {identity} from '../../backend/domains/shipping/src/identity.js';
import {
  DEMO_PASSWORD,
  GATEWAY_URL,
  JWT_SECRET,
  REPO_DIR,
} from '../stack/config.mjs';

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

/**
 * The shipping pack's roles (CB-44): the carrier's staff, who draft, approve and issue B/Ls, and
 * the trade staff of shippers, banks and buyers, who move the B/Ls they hold.
 */
export const CARRIER_ROLE = 'bld';
export const TRADE_ROLE = 'blt';

/** The password of the users the specs invite. */
export const INVITED_PASSWORD = 'e2e shipping user password 2026';

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
 * Accepts the invitation emailed to a user, with the password of invited users (INVITED_PASSWORD),
 * as the link in the email does (CB-43: also for users invited on the screens).
 * @param api the request context, on the gateway
 * @param email the invited user's email
 */
export async function acceptInvitation(
  api: APIRequestContext,
  email: string,
): Promise<void> {
  const token = new URL(
    appPath((await invitationEmail(email)).link).replace('/#/', '/'),
    'http://x',
  ).searchParams.get('token');
  const accepted = await api.post('/api/invitations/accept', {
    data: {token, password: INVITED_PASSWORD},
  });
  expect(accepted.status(), await accepted.text()).toBe(200);
}

/**
 * A new organisation with one office and one user of the given role, invited, activated and
 * signed in, all through the API as the administrator.
 * @param api the request context, on the gateway
 * @param admin the signed-in administrator
 * @param label a word for the names, e.g. "Bank"
 * @param role the user's role: the carrier's staff (CARRIER_ROLE) by default, TRADE_ROLE for a
 *     shipper, bank or buyer
 * @return the organisation and its signed-in clerk
 */
export async function organisationWithClerk(
  api: APIRequestContext,
  admin: SignedIn,
  label: string,
  role = CARRIER_ROLE,
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
  await acceptInvitation(api, email);

  const clerk = await signIn(api, email, INVITED_PASSWORD);
  expect(clerk.organisationId).toBe(organisation.id);
  return {
    id: organisation.id,
    code: organisation.code,
    name: organisation.name,
    clerk,
  };
}

/**
 * Signs a user in to the shipping app in the browser (CB-42): the platform's sign-in screen, then
 * the authenticator, whose secret their first sign-in through the API kept.
 * @param page the page, on the shipping app
 * @param email the user's email
 * @param password the user's password
 */
export async function signInOnScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const secret = readSecrets()[email];
  expect(secret, `the authenticator secret of ${email}`).toBeTruthy();
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByLabel('6-digit code').fill(codeFor(secret));
  await page.getByRole('button', {name: 'Verify and sign in'}).click();
}

/**
 * DCSA's example transport document (a B/L to order) with its own reference.
 * @param reference the transport document reference
 * @return the document
 */
export function negotiableBl(reference: string): Record<string, unknown> {
  const path = join(
    REPO_DIR,
    'backend',
    'domains',
    'shipping',
    'dcsa',
    '3.0.3',
    'examples',
    'td-regular.json',
  );
  const example = JSON.parse(readFileSync(path, 'utf8'));
  return {...example, transportDocumentReference: reference};
}

/**
 * Closes the toasts on the screen, so that a screenshot shows the page alone.
 * @param page the page
 */
export async function dismissToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', {name: 'Dismiss'});
  while ((await dismiss.count()) > 0) {
    // a toast may close by itself between the count and the click
    await dismiss
      .first()
      .click({timeout: 2_000})
      .catch(() => undefined);
  }
  await expect(dismiss).toHaveCount(0);
}

/**
 * Creates a B/L record, submits it, commits version 1 with four eyes (via bpm), and optionally
 * issues it to the shipper.
 * @param api the request context, on the gateway
 * @param carrier the carrier's signed-in clerk
 * @param approver the second person (four eyes) recorded as approver
 * @param options the document, linked parties, and whether to issue it
 * @param options.document the B/L document
 * @param options.partyOrganisations linked party organisation IDs
 * @param options.issue whether to issue the B/L after commit
 * @return the created B/L's id, label, and recordNo
 */
export async function committedBl(
  api: APIRequestContext,
  carrier: SignedIn,
  approver: {id: string; name: string},
  options: {
    document: object;
    partyOrganisations: Record<string, string>;
    issue?: boolean;
  },
): Promise<{id: string; label: string; recordNo: string}> {
  const created = await api.post('/api/records', {
    headers: carrier.headers,
    data: {
      format: 'dcsa-3.0',
      document: options.document,
      partyOrganisations: options.partyOrganisations,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const record = await created.json();
  const submitted = await api.post(
    `/api/records/${record.id}/versions/1/submit`,
    {headers: carrier.headers},
  );
  expect(submitted.status(), await submitted.text()).toBe(200);
  const committed = await api.post(
    `/api/records/${record.id}/versions/1/commit`,
    {
      headers: {authorization: `Bearer ${serviceToken('bpm')}`},
      data: {by: {id: approver.id, name: approver.name}},
    },
  );
  expect(committed.status(), await committed.text()).toBe(200);
  if (options.issue) {
    const issued = await api.post(`/api/records/${record.id}/title/issue`, {
      headers: carrier.headers,
      data: {},
    });
    expect(issued.status(), await issued.text()).toBe(200);
  }
  return {id: record.id, label: record.label, recordNo: record.recordNo};
}

/**
 * The verifier's blockchain queries, sent to the test chain behind the gateway instead: the
 * query's name (the last part of its path) is kept, the host is the gateway's.
 * @param url the address the verifier asks
 * @param init the request's options
 * @return the test chain's answer
 */
export function testChainFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const query = new URL(url).pathname.split('/').pop();
  return fetch(`${GATEWAY_URL}/api/audit/test/koios/${query}`, init);
}
