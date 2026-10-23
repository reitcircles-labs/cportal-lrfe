/**
 * The public check page of an ownership extract (API-693, designed in API-690): anyone holding an
 * extract opens `#/check` and types its check code (or scans its QR code, which opens
 * `#/check/<token>`), without signing in. The page says whether the extract matches the registry's
 * record and is still current, shows only what to compare with the paper, and checks the PDF file
 * in the browser against the file the registry sealed.
 *
 * The record is the canned AI's deed under a fresh number, for an erf of this run in Olympia, put on
 * the test blockchain by the test (POST /api/audit/test/anchorings). The states the stack cannot
 * produce on demand (the blockchain unreadable, a record that no longer matches, too many checks)
 * are shown with a made-up answer.
 */
import {expect, test, type Page} from '@playwright/test';
import {userByRole} from '../support/catalogue';
import {adminApi} from '../support/admin';
import {evidence} from '../support/evidence';
import {fileNumbered} from '../support/samples';
import {approvedChange, committedRecord} from '../support/records';
import {apiAs} from '../support/intake';

const rnd = (from: number, span: number) =>
  from + Math.floor(Math.random() * span);
/** An erf of this run, so reruns on one database start afresh. */
const ERF = rnd(50000, 9000);
const DEED = `T ${rnd(10000, 89999)}/2026`;

/** An issued extract, as the records officer's API gives it back. */
interface Issued {
  id: string;
  extractNo: string;
  checkCode: string;
  issuedAt: string;
}

let recordId = '';
let current: Issued;
let withdrawn: Issued;
/** The PDF of `current`, as issued. */
let pdf: Buffer;

/** "K7QF 2M9D XH4T", as the extract prints the code. */
const printed = (code: string) => code.match(/.{4}/g)!.join(' ');

/** The check page for `code`, as someone without an account opens it. */
async function openCheck(page: Page, code: string) {
  // a fresh load: the same address again would not open the page anew
  await page.goto('about:blank');
  await page.goto(`/#/check/${code}`);
  await expect(page.getByRole('heading', {level: 1})).toHaveText(
    'Check an ownership extract',
  );
  return page.locator('section.result');
}

test.use({storageState: {cookies: [], origins: []}});

test.describe
  .serial('The public check of an ownership extract (API-693)', () => {
  test.beforeAll(async ({playwright, baseURL}) => {
    test.setTimeout(240_000);
    await fileNumbered(playwright, baseURL!, DEED, {
      property: `ERF NO. ${ERF} OLYMPIA`,
    });
    const record = await committedRecord(playwright, baseURL!, DEED, {
      kind: 'erf',
      number: String(ERF),
      township: 'Olympia',
      regDiv: 'K',
    });
    recordId = record.id;

    // version 1 on the blockchain: batches until it is confirmed
    const admin = await adminApi(playwright, baseURL!);
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const h = {headers: rec.headers};
    await expect
      .poll(
        async () => {
          const made = await admin.api.post('/api/audit/test/anchorings', {
            headers: admin.headers,
            data: {outcome: 'confirmed'},
          });
          expect(made.status(), await made.text()).toBe(201);
          const history = await (
            await rec.api.get(`/api/records/${recordId}/history`, h)
          ).json();
          return history.versions[0]?.anchoring?.status;
        },
        {timeout: 30_000, intervals: [1000, 2000, 3000]},
      )
      .toBe('confirmed');
    await admin.dispose();

    // two extracts for Petrus Nghishidi; the second withdrawn
    const now = await (await rec.api.get(`/api/records/${recordId}`, h)).json();
    const ownerIndex = now.current.data.owners.findIndex(
      (o: {idNo?: string}) =>
        (o.idNo ?? '').replace(/\s/g, '') === '72110800345',
    );
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    const issue = async (): Promise<Issued> => {
      const res = await rec.api.post('/api/extracts', {
        ...h,
        data: {
          recordId,
          versionNumber: 1,
          ownerIndex,
          idNo: '72110800345',
          documentSeen: true,
        },
      });
      expect(res.status(), await res.text()).toBe(201);
      return res.json();
    };
    current = await issue();
    withdrawn = await issue();
    const revoked = await rec.api.post(`/api/extracts/${withdrawn.id}/revoke`, {
      ...h,
      data: {reason: 'The owner reported it lost'},
    });
    expect(revoked.status(), await revoked.text()).toBe(200);
    const file = await rec.api.get(`/api/extracts/${current.id}/pdf`, h);
    expect(file.status()).toBe(200);
    pdf = Buffer.from(await file.body());
    await rec.dispose();
  });

  test(
    'the check code typed in: the extract matches the record and is current, and nothing personal is shown',
    {tag: ['@API-693', '@API-694']},
    async ({page}) => {
      await page.goto('/#/check');
      // the registry, from the site's settings, and no sign-in
      await expect(page.locator('header.masthead')).toContainText(
        'Extract check · no login needed',
      );
      await expect(page.locator('header.masthead b')).not.toBeEmpty();
      const code = page.getByLabel('Check code');
      const check = page.getByRole('button', {name: 'Check'});
      await code.fill('K7QF 2M9D');
      await expect(check).toBeDisabled();
      await expect(page.locator('#code-help')).toHaveText(
        'A check code has 12 letters and digits.',
      );
      // as someone might type it: lower case, a dash
      await code.fill(
        printed(current.checkCode).toLowerCase().replace(' ', '-'),
      );
      await evidence(
        page,
        'API-693',
        'The check page without a code: type the check code printed on the extract',
      );
      await check.click();

      const result = page.locator('section.result');
      await expect(result.getByRole('heading')).toHaveText(
        "Matches the registry's record",
      );
      await expect(page).toHaveURL(new RegExp(`#/check/${current.checkCode}$`));
      await expect(page.locator('.sub')).toContainText(
        `Extract ${current.extractNo} · issued`,
      );
      await expect(result).toContainText('version 1.');
      await expect(result).toContainText('On the blockchain in batch');
      await expect(result).toContainText(
        '✓ Still the current version, checked just now',
      );
      const compare = page.locator('section', {
        hasText: 'Compare with your extract',
      });
      await expect(compare).toContainText(current.extractNo);
      await expect(compare).toContainText('Fingerprint');
      // nothing about the owners or the parcel
      for (const personal of [
        'Nghishidi',
        '72110800345',
        'Olympia',
        `${ERF}`,
      ]) {
        await expect(page.locator('body')).not.toContainText(personal);
      }
      await evidence(
        page,
        'API-693',
        'Matches and current: what to compare with the paper, and nothing personal',
      );
      await page.getByText('Check it yourself, without this page').click();
      await expect(
        page.getByText("The registry's seal fingerprint"),
      ).toBeVisible();
      await expect(
        page.getByRole('link', {name: 'Download the offline checker'}),
      ).toBeVisible();
      // the offline checker's command, with the registry's address and seal fingerprint (API-694)
      const command = page.locator('.cmd code');
      await expect(command).toContainText(
        /^node lrfe-verify\.mjs extract\.pdf --address \S+ --seal [0-9a-f]{64}$/,
      );
      await expect(command).not.toContainText('<the');
      await command.scrollIntoViewIfNeeded();
      await evidence(
        page,
        'API-694',
        'The offline checker on the check page: download it, and its command with the registry address and seal fingerprint',
      );
      await evidence(
        page,
        'API-693',
        'Check it yourself, without this page: the explorer, the address and the seal fingerprint, the offline checker',
      );

      await page.setViewportSize({width: 390, height: 844});
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(result.getByRole('heading')).toBeVisible();
      await evidence(page, 'API-693', 'The same check on a phone');
    },
  );

  test(
    'the PDF file checked in the browser: the sealed file matches, a changed one or another file does not',
    {tag: ['@API-693']},
    async ({page}) => {
      const result = await openCheck(page, current.checkCode);
      await expect(result.getByRole('heading')).toHaveText(
        "Matches the registry's record",
      );
      const uploads: string[] = [];
      page.on('request', r => {
        if (r.method() !== 'GET') uploads.push(r.url());
      });
      const input = page.locator('input[type=file]');
      const file = page.locator('section', {hasText: 'Check the PDF file too'});

      await input.setInputFiles({
        name: `${current.extractNo}.pdf`,
        mimeType: 'application/pdf',
        buffer: pdf,
      });
      await expect(file).toContainText(
        '✓ The file matches: it is exactly the PDF the registry sealed for this extract.',
      );
      // the file check's answer in the picture, not only the top of the page
      await file.scrollIntoViewIfNeeded();
      await evidence(
        page,
        'API-693',
        'The PDF file checked in the browser: it is the file the registry sealed',
      );

      // one byte changed, deep inside the file
      const changed = Buffer.from(pdf);
      changed[Math.floor(changed.length / 2)] ^= 1;
      await input.setInputFiles({
        name: `${current.extractNo}.pdf`,
        mimeType: 'application/pdf',
        buffer: changed,
      });
      await expect(result.getByRole('heading')).toHaveText(
        "This file doesn't match the registry's record",
      );
      await expect(file).toContainText(
        "✗ The file doesn't match: its contents differ from what the registry sealed.",
      );
      await evidence(
        page,
        'API-693',
        "A changed PDF file: it doesn't match the registry's record",
      );

      await input.setInputFiles({
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from('not a PDF at all'),
      });
      await expect(file).toContainText(
        "✗ This isn't a PDF file, so it isn't the registry's extract.",
      );
      await file.scrollIntoViewIfNeeded();
      await evidence(
        page,
        'API-693',
        "Another kind of file: it isn't the registry's extract PDF",
      );
      // the files were never sent anywhere
      expect(uploads).toEqual([]);
    },
  );

  test(
    'a withdrawn extract, and a code that matches no extract',
    {tag: ['@API-693']},
    async ({page}) => {
      let result = await openCheck(page, withdrawn.checkCode);
      await expect(result.getByRole('heading')).toHaveText(
        'This extract was withdrawn',
      );
      await expect(result).toContainText(
        'The registry withdrew this extract on',
      );
      // never the reason, which may name people
      await expect(page.locator('body')).not.toContainText('reported it lost');
      await evidence(page, 'API-693', 'An extract the registry withdrew');

      result = await openCheck(page, 'ZZZZZZZZZZZZ');
      await expect(result.getByRole('heading')).toHaveText(
        'No extract with this code',
      );
      await expect(page.locator('.sub')).toHaveText(
        'Check code ZZZZ ZZZZ ZZZZ',
      );
      await expect(page.getByText('Check the PDF file too')).toHaveCount(0);
      await evidence(page, 'API-693', 'A check code that matches no extract');
    },
  );

  test(
    "a viewer in another time zone sees the issue time printed on the extract, in the registry's time zone",
    {tag: ['@API-786']},
    async ({browser, baseURL}) => {
      // a context of its own: its own time zone, and the config's address
      const context = await browser.newContext({
        baseURL,
        timezoneId: 'America/New_York',
        storageState: {cookies: [], origins: []},
      });
      const page = await context.newPage();
      const answer = await page.request.get(
        `/api/public/extracts/${current.checkCode}`,
      );
      const {timeZone} = await answer.json();
      expect(timeZone).toBe('Africa/Windhoek');
      // the issue time as the PDF prints it (dateTimeText in the extracts service), short month
      const at = new Date(current.issuedAt);
      const date = at.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone,
      });
      const time = at.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone,
      });
      const issued = `${date}, ${time} (Windhoek time)`;
      await openCheck(page, current.checkCode);
      await expect(page.locator('.sub')).toContainText(`issued ${issued}`);
      await expect(
        page.locator('dt', {hasText: 'Issued'}).locator('+ dd'),
      ).toHaveText(issued);
      await evidence(
        page,
        'API-786',
        'The check page for a viewer in New York: the issue time as on the extract, in Windhoek time',
      );
      await context.close();
    },
  );

  test(
    'what the stack cannot make on demand, with made-up answers: the blockchain unreadable, a record that no longer matches, too many checks',
    {tag: ['@API-693']},
    async ({page, playwright, baseURL}) => {
      const anyone = await playwright.request.newContext({baseURL});
      const real = await (
        await anyone.get(`/api/public/extracts/${current.checkCode}`)
      ).json();
      await anyone.dispose();
      const answer = (body: object, status = 200) =>
        page.route(
          url => url.pathname.endsWith(`/public/extracts/${current.checkCode}`),
          route =>
            route.fulfill({
              status,
              contentType: 'application/json',
              body: JSON.stringify(body),
            }),
        );
      const blank = {
        fingerprintEnd: null,
        batch: null,
        transactionId: null,
        explorerUrl: null,
      };

      await answer({...real, ...blank, state: 'unavailable'});
      let result = await openCheck(page, current.checkCode);
      await expect(result.getByRole('heading')).toHaveText(
        "The blockchain can't be read right now",
      );
      await expect(result).toContainText(
        "The registry's record says this extract is valid and shows version 1.",
      );
      await expect(page.getByText('Compare with your extract')).toBeVisible();
      await evidence(
        page,
        'API-693',
        "The blockchain can't be read right now: the register says valid, not yet confirmed",
      );

      await page.unrouteAll();
      await answer({...real, ...blank, state: 'mismatch'});
      result = await openCheck(page, current.checkCode);
      await expect(result.getByRole('heading')).toHaveText(
        "This extract doesn't match the registry's record",
      );
      await evidence(
        page,
        'API-693',
        "The record no longer matches what is on the blockchain: don't rely on the extract",
      );

      await page.unrouteAll();
      await answer(
        {status: 429, message: 'Too many checks. Try again in a minute.'},
        429,
      );
      result = await openCheck(page, current.checkCode);
      await expect(result.getByRole('heading')).toHaveText(
        'Too many checks from this connection',
      );
      await evidence(page, 'API-693', 'Too many checks from one connection');
    },
  );

  test(
    'replaced: the record has a newer version, so the extract no longer shows the current record',
    {tag: ['@API-693']},
    async ({page, playwright, baseURL}) => {
      test.slow();
      await approvedChange(playwright, baseURL!, recordId, {
        zoning: 'Business 1',
      });
      const result = await openCheck(page, current.checkCode);
      await expect(result.getByRole('heading')).toHaveText(
        "Matches the registry's record, but it was replaced",
      );
      await expect(result).toContainText(
        'by version 2. This extract no longer shows the current record: ask the registry for a new extract.',
      );
      await evidence(
        page,
        'API-693',
        'Matches, but replaced by a newer version: ask the registry for a new extract',
      );
    },
  );
});
