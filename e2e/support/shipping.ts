/**
 * Helpers of the shipping product's API specs (tests-shipping/): signing a user in through the
 * gateway, and an organisation with a B/L clerk of its own, made by the administrator through the
 * API (CB-34).
 *
 * The shipping run has no setup project: the demo users start with the authenticators the stack's
 * seeding set up (CB-102, support/auth.ts demoSecretOf); an invited user sets one up while
 * accepting the invitation, and its secret is kept in .auth/totp.json so that a later spec signs
 * the same user in again. The shipping run has one worker, so the file is never written twice at
 * once.
 */
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  expect,
  type APIRequestContext,
  type Cookie,
  type Page,
} from '@playwright/test';
import {appPath, invitationEmail, officeCode, unique} from './admin';
import {
  codeFor,
  demoSecretOf,
  freshCodeFor,
  readSecrets,
  saveSecrets,
} from './auth';
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
 * Whether `email` is a seeded demo user's, whom the server lets reuse a code (CB-104).
 * @param email the user's email
 * @return true for a demo user
 */
function isDemoUser(email: string): boolean {
  return DEMO_USERS.some(u => u.email === email);
}

/**
 * The code to sign `email` in with now: a seeded demo user's current code, or for a user created
 * during a test a code not used yet (CB-104).
 * @param email the user's email
 * @return the 6-digit code
 */
export async function signInCodeFor(email: string): Promise<string> {
  const secret = secretFor(email);
  return isDemoUser(email) ? codeFor(secret) : freshCodeFor(secret);
}

/**
 * The authenticator secret of a user: a demo user's from the stack's seeding (CB-102), else the
 * one kept when they accepted their invitation.
 * @param email the user's email
 * @return the secret
 */
export function secretFor(email: string): string {
  if (isDemoUser(email)) {
    return demoSecretOf(email);
  }
  const secret = readSecrets()[email];
  expect(secret, `the authenticator secret of ${email}`).toBeTruthy();
  return secret;
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
 * A session of a user created during the run, kept by this worker so its helpers sign the user in
 * once (CB-104: a code is accepted once, so each new sign-in may wait for the next 30 s step).
 */
interface KeptSession {
  /** The API sign-in. */
  readonly signedIn?: SignedIn;
  /** When the API sign-in was made (ms). */
  readonly signedInAt?: number;
  /** The session's refresh cookie as last seen. */
  refreshCookie?: Cookie;
  /** The page that holds the refresh cookie, if any. */
  readonly page?: Page;
}

/** The kept sessions, by email. Demo users are not kept: the server lets them reuse a code. */
const keptSessions = new Map<string, KeptSession>();

/** How long a kept API sign-in is reused: well inside the access token's 15 minutes. */
const KEEP_API_SESSION_MS = 10 * 60_000;

/** The refresh cookie's name (the identity service's). */
const REFRESH_COOKIE = 'lrfe_rt';

/**
 * The kept API sign-in of `email`, when it is recent and the server still accepts it.
 * @param api the request context, on the gateway
 * @param email the user's email
 * @return the signed-in user, or undefined when a new sign-in is needed
 */
async function keptApiSession(
  api: APIRequestContext,
  email: string,
): Promise<SignedIn | undefined> {
  const kept = keptSessions.get(email);
  if (
    !kept?.signedIn ||
    Date.now() - (kept.signedInAt ?? 0) > KEEP_API_SESSION_MS
  ) {
    return undefined;
  }
  const me = await api.get('/api/auth/me', {headers: kept.signedIn.headers});
  if (!me.ok()) {
    return undefined;
  }
  return kept.signedIn;
}

/**
 * Keeps the session `page` is signed in with, for the next on-screen sign-in of `email`.
 * @param page the signed-in page
 * @param email the user's email
 */
async function keepScreenSession(page: Page, email: string): Promise<void> {
  const cookies = await page.context().cookies();
  const refreshCookie = cookies.find(c => c.name === REFRESH_COOKIE);
  keptSessions.set(email, {...keptSessions.get(email), refreshCookie, page});
}

/**
 * Opens the app in `page` with the kept session of `email`, when no other open page holds it.
 * @param page the page, on the shipping app
 * @param email the user's email
 * @return whether `page` is now signed in
 */
async function resumeOnScreen(page: Page, email: string): Promise<boolean> {
  const kept = keptSessions.get(email);
  if (!kept?.refreshCookie || (kept.page && !kept.page.isClosed())) {
    return false;
  }
  // the cookie moves to this page, which refreshes the session from now on
  const refreshCookie = kept.refreshCookie;
  kept.refreshCookie = undefined;
  await page.context().addCookies([refreshCookie]);
  // the app resumes a session when it starts: a page already showing it (after "Sign out") leaves
  // it first, as going to its home would only change the hash
  if (page.url() !== 'about:blank') {
    await page.goto('about:blank');
  }
  const refreshed = page
    .waitForResponse(r => r.url().endsWith('/api/auth/refresh'), {
      timeout: 10_000,
    })
    .catch(() => undefined);
  await page.goto('/#/');
  const answer = await refreshed;
  if (answer?.status() !== 200) {
    return false;
  }
  await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
  await keepScreenSession(page, email);
  return true;
}

/**
 * Signs a user in through the API: password, then the authenticator, with the secret kept for the
 * user (an invited user's, from the invitation) or else the demo user's from the stack's seeding.
 * A user created during the run signs in once: their session is kept and reused while it is valid
 * (CB-104), whatever `password` is given then.
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
  const kept = isDemoUser(email) ? undefined : await keptApiSession(api, email);
  if (kept) {
    return kept;
  }
  const login = await api.post('/api/auth/login', {data: {email, password}});
  expect(login.status(), `sign-in of ${email}: ${await login.text()}`).toBe(
    200,
  );
  const first = await login.json();
  expect(first.next, `sign-in of ${email}`).toBe('mfa');
  const mfa = await api.post('/api/auth/mfa', {
    data: {challenge: first.challenge, code: await signInCodeFor(email)},
  });
  expect(mfa.status(), `authenticator of ${email}: ${await mfa.text()}`).toBe(
    200,
  );
  const {accessToken, me} = await mfa.json();
  const signedIn: SignedIn = {
    id: me.user.id,
    name: me.user.name,
    email,
    organisationId: me.user.organisationId,
    headers: {authorization: `Bearer ${accessToken}`},
  };
  if (!isDemoUser(email)) {
    const {cookies} = await api.storageState();
    keptSessions.set(email, {
      signedIn,
      signedInAt: Date.now(),
      refreshCookie: cookies.find(c => c.name === REFRESH_COOKIE),
    });
  }
  return signedIn;
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
  // CB-102: the authenticator is set up with the invitation, before the link is used up
  const {next, secret} = await accepted.json();
  expect(next, 'two-factor sign-in is required').toBe('mfa-enroll');
  const activated = await api.post('/api/invitations/accept', {
    data: {token, password: INVITED_PASSWORD, code: await freshCodeFor(secret)},
  });
  expect(activated.status(), await activated.text()).toBe(200);
  saveSecrets({...readSecrets(), [email]: secret});
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
 * the authenticator, whose secret their first sign-in through the API kept. A user created during
 * the run opens the app with their kept session instead, when no open page holds it (CB-104).
 * @param page the page, on the shipping app
 * @param email the user's email
 * @param password the user's password
 */
export async function signInOnScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  // a user created during the run opens the app with their kept session (CB-104)
  const created = !isDemoUser(email);
  if (created && (await resumeOnScreen(page, email))) {
    return;
  }
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByLabel('6-digit code').fill(await signInCodeFor(email));
  await page.getByRole('button', {name: 'Verify and sign in'}).click();
  if (created) {
    await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
    await keepScreenSession(page, email);
  }
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
