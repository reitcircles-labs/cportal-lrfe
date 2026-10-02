/**
 * The sign-in screen: password, authenticator code, first-time enrolment, refusals, sign-out.
 */
import { expect, test, type Page } from '@playwright/test';
import { MATRIX_USERS, MFA_UI_USER, demoUser, userByRole } from '../support/catalogue';
import { apiSignIn, codeFor, secretOf } from '../support/auth';
import { DEMO_PASSWORD } from '../stack/config.mjs';

async function enterPassword(page: Page, email: string, password = DEMO_PASSWORD) {
    await page.goto('/#/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function enterCode(page: Page, code: string) {
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
}

for (const user of MATRIX_USERS) {
    test(`${user.label} signs in with password and code, and lands on ${user.home}`, async ({ page }) => {
        await enterPassword(page, user.email);
        await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
        await enterCode(page, codeFor(secretOf(user.email)));
        await expect(page).toHaveURL(new RegExp(`#${user.home === '/' ? '/$' : user.home + '$'}`));
        await expect(page.locator('aside.sidebar')).toContainText(user.name);
    });
}

test('a wrong password is refused', async ({ page }) => {
    await enterPassword(page, userByRole('scan').email, 'not-the-password');
    await expect(page.getByRole('alert')).toHaveText('Wrong email or password');
});

test('a wrong authenticator code is refused', async ({ page }) => {
    const user = userByRole('rev');
    await enterPassword(page, user.email);
    const good = codeFor(secretOf(user.email));
    await enterCode(page, good === '000000' ? '111111' : '000000');
    await expect(page.getByRole('alert')).toHaveText('Invalid authenticator code');
});

test('a suspended user cannot sign in', async ({ page }) => {
    await enterPassword(page, demoUser('Suspended').email);
    await expect(page.getByRole('alert')).toContainText('suspended');
});

test('an invited user who has not activated cannot sign in with a password', async ({ page }) => {
    await enterPassword(page, demoUser('Invited').email);
    await expect(page.getByRole('alert')).toHaveText('Wrong email or password');
});

test('first sign-in sets up the authenticator from the setup key', async ({ page, playwright }) => {
    // Start from "not enrolled" whatever an earlier run did: an administrator resets the user's MFA.
    const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    const token = await apiSignIn(admin, userByRole('adm').email);
    const headers = { authorization: `Bearer ${token}` };
    const { users } = await (await admin.get('/api/users', { headers })).json();
    const target = users.find((u: { email: string }) => u.email === MFA_UI_USER);
    expect((await admin.post(`/api/users/${target.id}/mfa-reset`, { headers })).status()).toBe(200);
    await admin.dispose();

    await enterPassword(page, MFA_UI_USER);
    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await page.getByText("Can't scan? Type the setup key instead").click();
    const key = (await page.locator('code.key').textContent())!.replace(/\s/g, '');
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    await enterCode(page, codeFor(key));
    await expect(page).toHaveURL(/#\/capture$/);
});

test('the session survives a page reload, and signing out ends it', async ({ page }) => {
    const user = userByRole('rec');
    await enterPassword(page, user.email);
    await enterCode(page, codeFor(secretOf(user.email)));
    await expect(page).toHaveURL(/#\/link$/);

    await page.reload();
    await expect(page).toHaveURL(/#\/link$/);
    await expect(page.locator('aside.sidebar')).toContainText(user.name);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/#\/login/);
    await page.goto('/#/link');
    await expect(page).toHaveURL(/#\/login\?returnUrl=%2Flink/);
});
