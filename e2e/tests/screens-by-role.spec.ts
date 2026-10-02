/**
 * Every role × every screen, in the browser: the menu shows exactly the screens the role may open,
 * an allowed screen opens without server errors, a forbidden one shows "Access denied".
 * Roles, permissions and screens come from the app's sources (support/catalogue.ts).
 */
import { expect, test, type Response } from '@playwright/test';
import { MATRIX_USERS, SCREENS, can } from '../support/catalogue';
import { signInAs } from '../support/auth';
import { trackApi } from '../support/api-idle';

const hrefOf = (path: string) => `#/${path}`;
/** The screen's URL, optionally with a query: Verify and Documents add the open document (?doc=, ?id=). */
const urlOf = (path: string) => new RegExp(`#/${path}(\\?.*)?$`);

for (const user of MATRIX_USERS) {
    test(`${user.label}: menu and screens follow the role's permissions`, async ({ page }) => {
        const pageErrors: string[] = [];
        page.on('pageerror', err => pageErrors.push(err.message));
        let apiProblems: string[] = [];
        page.on('response', (res: Response) => {
            const path = new URL(res.url()).pathname;
            // A 403 while on an allowed screen means the screen calls an endpoint its role may not use.
            if (path.startsWith('/api/') && (res.status() >= 500 || res.status() === 403)) {
                apiProblems.push(`${res.request().method()} ${path} → ${res.status()}`);
            }
        });

        const apiIdle = trackApi(page);
        await signInAs(page, user.email, user.home);

        await test.step('menu', async () => {
            const expected = SCREENS.filter(s => can(user, s.anyOf)).map(s => hrefOf(s.path)).sort();
            const shown = (await page.locator('nav.nav a').evaluateAll(as => as.map(a => a.getAttribute('href')))).sort();
            expect.soft(shown, 'links in the side menu').toEqual(expected);
        });

        for (const screen of SCREENS) {
            const allowed = can(user, screen.anyOf);
            await test.step(`/${screen.path} ${allowed ? 'opens' : 'is denied'}`, async () => {
                apiProblems = [];
                await page.goto(`/${hrefOf(screen.path)}`);
                const heading = page.locator('header.topbar h1');
                if (allowed) {
                    await expect.soft(page).toHaveURL(urlOf(screen.path));
                    await expect.soft(heading).toHaveText(screen.title);
                    await apiIdle();
                    expect.soft(apiProblems, `API errors while on /${screen.path}`).toEqual([]);
                } else {
                    await expect.soft(page).toHaveURL(new RegExp(`#/denied\\?perm=${screen.anyOf[0].replace('.', '\\.')}$`));
                    await expect.soft(page.getByRole('heading', { name: "You don't have access to this area" })).toBeVisible();
                }
            });
        }
        expect.soft(pageErrors, 'uncaught errors in the page').toEqual([]);
    });
}
