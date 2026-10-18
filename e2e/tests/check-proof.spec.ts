/**
 * The public "Check a proof yourself" page (API-676): reachable without signing in, with the
 * installation's published anchoring wallet and explorer links from the audit service, and the
 * offline verifier to download.
 */
import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import {evidence} from '../support/evidence';
import {GATEWAY_URL} from '../stack/config.mjs';

test(
  'anyone given a proof can open "Check a proof yourself" without signing in, with the wallet, the explorer and the verifier',
  {tag: ['@API-676']},
  async ({browser}) => {
    const wallet = await (
      await fetch(`${GATEWAY_URL}/api/audit/anchoring/wallet`)
    ).json();
    expect(wallet.address).toMatch(/^addr_test1/);

    // a fresh browser, nobody signed in; the sign-in page links to it
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: {width: 1280, height: 1000},
    });
    const page = await context.newPage();
    await page.goto('/#/login');
    await page.getByRole('link', {name: 'Check it yourself'}).click();
    await expect(page).toHaveURL(/#\/check-a-proof$/);
    await expect(
      page.getByRole('heading', {level: 1, name: 'Check a proof yourself'}),
    ).toBeVisible();
    await expect(
      page.getByRole('complementary', {name: 'Main navigation'}),
    ).toHaveCount(0);
    await evidence(
      page,
      'API-676',
      '"Check a proof yourself", without signing in: what a proof shows and how to check it',
    );

    // the configured wallet, in the command and on its own, with its explorer page
    await expect(
      page.locator('code', {
        hasText: `node lrfe-verify.mjs proof.json --address ${wallet.address}`,
      }),
    ).toBeVisible();
    await expect(page.locator('code.addr')).toHaveText(wallet.address);
    await expect(
      page.getByRole('link', {name: /See every batch this wallet wrote/}),
    ).toHaveAttribute('href', wallet.explorerUrl);

    // a transaction id opens on the explorer
    const tx = 'ab'.repeat(32);
    await page.getByPlaceholder('64 characters, 0–9 and a–f').fill(tx);
    await expect(
      page.getByRole('link', {
        name: /Open the transaction on a public blockchain explorer/,
      }),
    ).toHaveAttribute('href', wallet.transactionUrl + tx);

    // plain language: the network and the tools are not named on the page
    expect(await page.locator('main').innerText()).not.toMatch(
      /Cardano|preview|Koios|Blockfrost|Ogmios|OpenBao/i,
    );
    await page
      .getByRole('link', {
        name: /Open the transaction on a public blockchain explorer/,
      })
      .scrollIntoViewIfNeeded();
    await evidence(
      page,
      'API-676',
      'The published anchoring wallet, its explorer page, and a transaction looked up on the explorer',
    );

    // the verifier downloads as the registry's own file
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', {name: 'Download the verifier'}).click(),
    ]);
    expect(download.suggestedFilename()).toBe('lrfe-verify.mjs');
    expect(readFileSync(await download.path(), 'utf8')).toContain(
      'export async function verifyProof',
    );
    await context.close();
  },
);
