/**
 * Administration, as the system administrator (API-607): offices, inviting a user who activates
 * their account from the email, role changes, segregation of duties, suspension, security policies
 * and the permission matrix, each checked in the access log.
 *
 * Tests work on users and offices they create themselves, so they run in parallel with the rest.
 * The last test changes settings every user shares (a policy, a rule, one permission of one role);
 * it picks changes that no other test depends on and puts them back.
 */
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { userByRole } from '../support/catalogue';
import { apiSignIn, codeFor, signInAs } from '../support/auth';
import { NEW_USER_PASSWORD, adminApi, appPath, createUser, inviteLink, officeCode, unique, type NewUser } from '../support/admin';
import { evidence } from '../support/evidence';

const ADMIN = userByRole('adm');
const tag = { tag: '@API-607' };

/** Each person in their own browser context. */
async function as(browser: Browser, email: string, path: string, password?: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await signInAs(page, email, path, password);
    return page;
}

/** The input or select under a form label (the admin dialogs' labels are not tied to their fields). */
const field = (scope: Locator, label: string) => scope.locator(`.field:has(> label:text-is("${label}"))`).locator('input, select');
const confirmWith = (page: Page, button: string) => page.getByRole('alertdialog').getByRole('button', { name: button, exact: true }).click();
/** The newest toast with this text (an earlier one may still be showing). */
const toast = (page: Page, text: string | RegExp) => page.locator('.toast', { hasText: text }).last();

async function openUser(page: Page, user: { name: string; email: string }): Promise<Locator> {
    // Suspending or reactivating leaves the drawer open; close it before opening one again.
    const open = page.locator('aside.drawer');
    if (await open.count()) await open.getByRole('button', { name: 'Close' }).click();
    await page.goto('/#/admin/users');
    await page.getByLabel('Search users').fill(user.email);
    await page.locator('tr', { hasText: user.email }).getByRole('button', { name: 'Manage' }).click();
    const drawer = page.getByRole('dialog', { name: `Manage ${user.name}` });
    await expect(drawer).toBeVisible();
    return drawer;
}

/** Access log rows whose Action column is exactly `action`. */
const action = (rows: Locator, name: string) =>
    rows.filter({ has: rows.page().locator('td:nth-child(4)', { hasText: new RegExp(`^${name}$`) }) });

async function logRows(page: Page, kind: string, search: string): Promise<Locator> {
    await page.goto('/#/admin/log');
    await page.locator('.seg-opt', { hasText: kind }).click();
    await page.getByLabel('Search access log').fill(search);
    return page.locator('tbody tr');
}

test('an administrator adds, edits, suspends and reactivates an office', tag, async ({ browser }) => {
    const code = officeCode();
    const name = `E2E Office ${code}`;
    const page = await as(browser, ADMIN.email, '/admin/offices');

    await page.getByRole('button', { name: 'Add office' }).first().click();
    const dialog = page.locator('.dialog');
    await field(dialog, 'Code').fill(code);
    await field(dialog, 'Type').selectOption({ label: 'External body' });
    await field(dialog, 'Name').fill(name);
    await field(dialog, 'Address (optional)').fill('1 Test Street, Windhoek');
    await evidence(page, 'API-607', 'Offices: adding an office');
    await dialog.getByRole('button', { name: 'Add office' }).click();
    await expect(toast(page, `Office ${code} added`)).toBeVisible();
    const row = page.locator('tbody tr', { hasText: code });
    await expect(row).toContainText(name);
    await expect(row).toContainText('External body');
    await expect(row).toContainText('Active');

    // Edit: the code is fixed, the rest can change.
    await row.click();
    await expect(field(dialog, 'Code')).toHaveAttribute('readonly', '');
    await field(dialog, 'Contact (optional)').fill('+264 61 000 000');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page, `Office ${code} saved`)).toBeVisible();

    // Suspend: no new invitations into it.
    await row.click();
    await dialog.getByRole('button', { name: 'Suspend office' }).click();
    await confirmWith(page, 'Suspend office');
    await expect(row).toContainText('Suspended');
    await evidence(page, 'API-607', 'Offices: the new office is suspended');
    await page.goto('/#/admin/users');
    await page.getByRole('button', { name: 'Invite user' }).click();
    await expect(field(page.locator('.dialog'), 'Office').locator('option', { hasText: code })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.goto('/#/admin/offices');
    await row.click();
    await dialog.getByRole('button', { name: 'Reactivate office' }).click();
    await confirmWith(page, 'Reactivate');
    await expect(row).toContainText('Active');

    const log = await logRows(page, 'Offices', code);
    await expect(action(log, 'Office added')).toHaveCount(1);
    await expect(action(log, 'Office updated')).toHaveCount(1);
    await expect(action(log, 'Office suspended')).toHaveCount(1);
    await expect(action(log, 'Office reactivated')).toHaveCount(1);
    await expect(log.first()).toContainText(ADMIN.name);
    await evidence(page, 'API-607', 'Access log: every office change, by the administrator');
});

test('an invited user activates their account from the email and signs in for the first time', tag, async ({ browser }) => {
    const id = unique();
    const person = { name: `E2E Invitee ${id}`, email: `e2e.invitee.${id}@deeds.gov.na` };
    const admin = await as(browser, ADMIN.email, '/admin/users');

    await admin.getByRole('button', { name: 'Invite user' }).click();
    const dialog = admin.locator('.dialog');
    await field(dialog, 'Full name').fill(person.name);
    await field(dialog, 'Work email').fill(person.email);
    await field(dialog, 'Office').selectOption({ label: 'WDH · Deeds Registry · Windhoek' });
    await field(dialog, 'Role').selectOption({ label: 'Records officer' });
    await evidence(admin, 'API-607', 'Invite: the administrator invites a records officer');
    await dialog.getByRole('button', { name: 'Create invitation' }).click();
    await expect(toast(admin, `Invitation sent to ${person.name}`)).toBeVisible();
    await admin.getByLabel('Search users').fill(person.email);
    const row = admin.locator('tbody tr', { hasText: person.email });
    await expect(row).toContainText('Invited');
    await expect(row).toContainText('Not enrolled');

    // The invitee opens the link from the email, chooses a password, then signs in and sets up MFA.
    const link = await inviteLink(person.email);
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const page = await context.newPage();
    await page.goto(appPath(link));
    await expect(page.getByRole('heading', { name: 'Activate your account' })).toBeVisible();
    await page.getByLabel('New password').fill(NEW_USER_PASSWORD);
    await page.getByLabel('Repeat password').fill(NEW_USER_PASSWORD);
    await evidence(page, 'API-607', 'Invite: the invitee chooses a password from the email link');
    await page.getByRole('button', { name: 'Activate account' }).click();
    await expect(page.getByText('Your account is active. Sign in with your new password.')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue(person.email);
    await page.getByLabel('Password').fill(NEW_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
    await page.getByText("Can't scan? Type the setup key instead").click();
    const key = (await page.locator('code.key').textContent())!.replace(/\s/g, '');
    await page.getByLabel('6-digit code').fill(codeFor(key));
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/#\/link$/);
    await expect(page.locator('aside.sidebar')).toContainText(person.name);
    await evidence(page, 'API-607', 'Invite: first sign-in done, on the records officer home');

    // The link works once.
    const again = await context.newPage();
    await again.goto(appPath(link));
    await again.getByLabel('New password').fill(NEW_USER_PASSWORD);
    await again.getByLabel('Repeat password').fill(NEW_USER_PASSWORD);
    await again.getByRole('button', { name: 'Activate account' }).click();
    await expect(again.getByRole('alert')).toContainText('This invitation is invalid or has expired');

    await admin.reload();
    await admin.getByLabel('Search users').fill(person.email);
    await expect(row).toContainText('Active');
    await expect(row.locator('.ok')).toBeVisible();   // MFA enrolled
    await evidence(admin, 'API-607', 'Invite: the administrator sees the user active with MFA');
});

test('role changes decide what the user can open', tag, async ({ browser, playwright }) => {
    const admin = await adminApi(playwright, test.info().project.use.baseURL!);
    const user = await createUser(admin, ['rec'], 'roles');
    await admin.dispose();
    const page = await as(browser, ADMIN.email, '/admin/users');

    let drawer = await openUser(page, user);
    await drawer.locator('label.rpick', { hasText: 'Scan operator' }).locator('input').check();
    await evidence(page, 'API-607', 'Roles: adding Scan operator to a records officer');
    await drawer.getByRole('button', { name: 'Save roles' }).click();
    await expect(toast(page, `Roles updated for ${user.name}`)).toBeVisible();

    const them = await as(browser, user.email, '/capture', NEW_USER_PASSWORD);
    await expect(them.locator('header.topbar h1')).toHaveText('Capture');
    await expect(them.locator('nav.nav')).toContainText('Capture');
    await them.context().close();

    drawer = await openUser(page, user);
    await drawer.locator('label.rpick', { hasText: 'Records officer' }).locator('input').uncheck();
    await drawer.getByRole('button', { name: 'Save roles' }).click();
    await expect(toast(page, `Roles updated for ${user.name}`)).toBeVisible();

    const after = await as(browser, user.email, '/link', NEW_USER_PASSWORD);
    await expect(after).toHaveURL(/#\/denied\?perm=record\.view$/);
    await expect(after.locator('nav.nav')).not.toContainText('Land record');

    const log = await logRows(page, 'Users', user.name);
    await expect(action(log, 'Roles changed').filter({ hasText: '+ Scan operator' })).toHaveCount(1);
    await expect(action(log, 'Roles changed').filter({ hasText: '− Records officer' })).toHaveCount(1);
    await evidence(page, 'API-607', 'Access log: both role changes');
});

test('a segregation-of-duties conflict is flagged before and after saving', tag, async ({ browser, playwright }) => {
    const admin = await adminApi(playwright, test.info().project.use.baseURL!);
    const user = await createUser(admin, ['rev'], 'sod');
    await admin.dispose();
    const page = await as(browser, ADMIN.email, '/admin/users');

    const drawer = await openUser(page, user);
    await drawer.locator('label.rpick', { hasText: 'Auditor · read-only' }).locator('input').check();
    await expect(drawer.locator('.alert')).toContainText('Segregation-of-duties conflict');
    await expect(drawer.locator('.alert')).toContainText('Reviewers cannot audit documents they can file');
    await drawer.locator('.alert').scrollIntoViewIfNeeded();
    await evidence(page, 'API-607', 'Duties: the conflict is shown before saving');

    // Saving needs an explicit "Save anyway"; cancelling keeps the user as they were.
    await drawer.getByRole('button', { name: 'Save roles' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Save with a duty conflict?');
    await confirmWith(page, 'Save anyway');
    await expect(toast(page, `Roles updated for ${user.name}`)).toBeVisible();
    const row = page.locator('tbody tr', { hasText: user.email });
    await expect(row.locator('.tag', { hasText: 'Conflict' })).toBeVisible();
    await evidence(page, 'API-607', 'Duties: the user is flagged with a conflict');

    const log = await logRows(page, 'Users', user.name);
    await expect(action(log, 'Roles changed').filter({ hasText: '+ Auditor · read-only' })).toHaveCount(1);
});

test('a suspended user is signed out and cannot sign in until reactivated', tag, async ({ browser, playwright }) => {
    const admin = await adminApi(playwright, test.info().project.use.baseURL!);
    const user = await createUser(admin, ['rec'], 'suspend');
    await admin.dispose();
    const them = await as(browser, user.email, '/link', NEW_USER_PASSWORD);
    const page = await as(browser, ADMIN.email, '/admin/users');

    let drawer = await openUser(page, user);
    await drawer.getByRole('button', { name: 'Suspend' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Active sessions end immediately and sign-in is blocked.');
    await confirmWith(page, 'Suspend user');
    await expect(toast(page, `${user.name} suspended`)).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: user.email })).toContainText('Suspended');
    await evidence(page, 'API-607', 'Suspension: the user is suspended');

    // Their open session cannot continue past a reload, and a new sign-in is refused.
    await them.reload();
    await expect(them).toHaveURL(/#\/login/);
    await them.getByLabel('Email').fill(user.email);
    await them.getByLabel('Password').fill(NEW_USER_PASSWORD);
    await them.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(them.getByRole('alert')).toContainText('This account is suspended');
    await evidence(them, 'API-607', 'Suspension: sign-in is refused');

    drawer = await openUser(page, user);
    await drawer.getByRole('button', { name: 'Reactivate' }).click();
    await confirmWith(page, 'Reactivate');
    await expect(toast(page, `${user.name} reactivated`)).toBeVisible();
    const back = await as(browser, user.email, '/link', NEW_USER_PASSWORD);
    await expect(back.locator('header.topbar h1')).toHaveText('Land record (create/finalize)');

    const log = await logRows(page, 'All', user.name);
    await expect(action(log, 'Suspended')).toHaveCount(1);
    await expect(action(log, 'Sign-in blocked')).toHaveCount(1);
    await expect(action(log, 'Reactivated')).toHaveCount(1);
    await evidence(page, 'API-607', 'Access log: suspension, the refused sign-in and reactivation');
});

test('security policies and the permission matrix are saved, take effect and are logged', tag, async ({ browser, playwright }) => {
    const page = await as(browser, ADMIN.email, '/admin/policies');
    const rule = page.locator('label.prow', { hasText: 'Scan operators cannot file what they capture' });

    // A longer idle timeout and an extra duty rule: no other test depends on either.
    await page.locator('.seg-opt', { hasText: '60 min' }).click();
    await rule.locator('input').check();
    await expect(rule).toContainText('affected');   // users holding both permissions are counted
    await evidence(page, 'API-607', 'Policies: 60 min timeout and an extra duty rule, unsaved');
    await page.getByRole('button', { name: 'Save policies' }).click();
    await confirmWith(page, 'Save policies');
    await expect(toast(page, 'Security policies saved')).toBeVisible();
    await page.reload();
    await expect(page.locator('.seg-opt', { hasText: '60 min' }).locator('input')).toBeChecked();
    await expect(rule.locator('input')).toBeChecked();

    // One permission for one role: auditors may comment on records (no screen or endpoint tested
    // elsewhere depends on it). It reaches the auditor's token at their next sign-in.
    await page.goto('/#/admin/roles');
    await page.getByLabel('Auditor · read-only: Comment on records').check();
    await expect(page.locator('.savebar')).toContainText('1 unsaved permission change');
    await evidence(page, 'API-607', 'Permission matrix: one change, unsaved');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await confirmWith(page, 'Save changes');
    await expect(toast(page, 'Permission matrix saved')).toBeVisible();
    const auditor = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    const token = await apiSignIn(auditor, userByRole('aud').email);
    const me = await (await auditor.get('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })).json();
    expect(me.perms).toContain('record.comment');
    await auditor.dispose();

    // Put everything back.
    await page.getByLabel('Auditor · read-only: Comment on records').uncheck();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await confirmWith(page, 'Save changes');
    await expect(toast(page, 'Permission matrix saved')).toBeVisible();
    await page.goto('/#/admin/policies');
    await page.locator('.seg-opt', { hasText: '30 min' }).click();
    await rule.locator('input').uncheck();
    await page.getByRole('button', { name: 'Save policies' }).click();
    await confirmWith(page, 'Save policies');
    await expect(toast(page, 'Security policies saved')).toBeVisible();

    const log = await logRows(page, 'All', ADMIN.name);
    await expect(action(log, 'Policy updated').filter({ hasText: 'Session timeout 30 → 60 min' })).toHaveCount(1);
    await expect(action(log, 'Policy updated').filter({ hasText: 'Enabled: Scan operators cannot file what they capture' })).toHaveCount(1);
    await expect(action(log, 'Permissions changed').filter({ hasText: 'Auditor · read-only' })).toHaveCount(2);
    await expect(action(log, 'Policy updated').filter({ hasText: 'Session timeout 60 → 30 min' })).toHaveCount(1);
    await evidence(page, 'API-607', 'Access log: policy and permission changes, and their reversal');
});

// ---------------------------------------------------------------- known bugs
// Marked test.fail(): they pass while the bug is there and fail ("expected to fail, but passed")
// as soon as it is fixed, which is the signal to remove the marker.

test("the access log records a duty-conflict exception", { tag: ['@API-607', '@API-611'] }, async ({ playwright }) => {
    test.fail(true, 'API-611: the log only says "Roles changed", not that a duty rule was broken');
    const admin = await adminApi(playwright, test.info().project.use.baseURL!);
    const user = await createUser(admin, ['rev'], 'sodlog');
    await admin.api.put(`/api/users/${user.id}/roles`, { headers: admin.headers, data: { roles: ['rev', 'aud'] } });
    const { items } = await (await admin.api.get('/api/access-log', { headers: admin.headers })).json();
    const change = items.find((e: { action: string; target: string }) => e.action === 'Roles changed' && e.target === user.name);
    await admin.dispose();
    expect(change, 'a "Roles changed" entry').toBeTruthy();
    expect(change.detail).toContain('Reviewers cannot audit documents they can file');
});

test("a suspended user's existing token stops working at once", { tag: ['@API-607', '@API-610'] }, async ({ playwright }) => {
    test.fail(true, 'API-610: the access token keeps working until it expires (up to 15 minutes)');
    const base = test.info().project.use.baseURL!;
    const admin = await adminApi(playwright, base);
    const user = await createUser(admin, ['rec'], 'suspendtoken');
    const theirs = await playwright.request.newContext({ baseURL: base });
    const headers = { authorization: `Bearer ${await apiSignIn(theirs, user.email, NEW_USER_PASSWORD)}` };
    expect((await theirs.get('/api/documents', { headers })).status()).toBe(200);

    expect((await admin.api.post(`/api/users/${user.id}/suspend`, { headers: admin.headers, data: {} })).status()).toBe(200);
    expect((await theirs.post('/api/auth/refresh')).status(), 'renewing is refused').toBe(401);
    for (const path of ['/api/auth/me', '/api/documents', '/api/tasks', '/api/intake/catalogue']) {
        expect.soft((await theirs.get(path, { headers })).status(), `${path} with the token from before the suspension`).toBe(401);
    }
    await theirs.dispose();
    await admin.dispose();
});

test('dropdowns show the value the screen holds', { tag: ['@API-607', '@API-612'] }, async ({ browser, playwright }) => {
    test.fail(true, 'API-612: the dropdowns display their first option, not the selected value');
    const admin = await adminApi(playwright, test.info().project.use.baseURL!);
    const user = await createUser(admin, ['rec'], 'dropdown');   // in WDH, which is not the first office
    const code = officeCode();
    await admin.api.post('/api/offices', { headers: admin.headers, data: { code, name: `E2E External ${code}`, type: 'external' } });
    await admin.dispose();
    const shown = (select: Locator) => select.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text);
    const page = await as(browser, ADMIN.email, '/admin/users');

    await page.getByRole('button', { name: 'Invite user' }).click();
    expect.soft(await shown(field(page.locator('.dialog'), 'Role')), 'invite: the default role').toBe('Metadata reviewer');
    await page.getByRole('button', { name: 'Cancel' }).click();

    const drawer = await openUser(page, user);
    expect.soft(await shown(drawer.locator('select[aria-label="Office"]')), "drawer: the user's office").toBe('WDH · Deeds Registry · Windhoek');

    await page.goto('/#/admin/offices');
    await page.locator('tbody tr', { hasText: code }).click();
    expect.soft(await shown(field(page.locator('.dialog'), 'Type')), "edit office: the office's type").toBe('External body');
});
