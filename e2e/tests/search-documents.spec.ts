/**
 * Document search through the search index (API-803): only on the containers with
 * EDRMS_SEARCH=opensearch (`EDRMS_SEARCH=opensearch npm run test:docker`), where edrms asks the
 * index. A scan is found as soon as the AI has read it, marked "In intake", and opens its review
 * in Verify metadata; once filed, the same document is found with the reviewer's corrected
 * values; a user without intake's read permission never finds a scan still in intake.
 */
import {expect, test} from '@playwright/test';
import {trackApi} from '../support/api-idle';
import {userByRole} from '../support/catalogue';
import {signedInPage} from '../support/auth';
import {evidence} from '../support/evidence';
import {type Api, apiAs, readyDocument, sampleDeed} from '../support/intake';

test.skip(
  !process.env.E2E_DOCKER || process.env.EDRMS_SEARCH !== 'opensearch',
  'only against the containers with EDRMS_SEARCH=opensearch',
);

const tag = {tag: '@API-803'};

interface Found {
  id: string;
  status: 'filed' | 'intake';
  edrmsNo: string;
  instrumentRef: string | null;
  fields: Array<{k: string; v: string}>;
}

/** What the Documents search finds for `q`, as this person. */
async function search(who: Api, q: string): Promise<Found[]> {
  const res = await who.api.get('/api/documents', {
    headers: who.headers,
    params: {q, limit: 50},
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).items;
}

/** Waits until a search for `q` finds the document `id` (the index is written within seconds). */
async function foundSoon(who: Api, q: string, id: string): Promise<Found> {
  let hit: Found | undefined;
  await expect
    .poll(
      async () => {
        hit = (await search(who, q)).find(d => d.id === id);
        return !!hit;
      },
      {timeout: 20_000},
    )
    .toBe(true);
  return hit!;
}

test(
  'a scan is found right after the AI read it, marked "In intake", and opens its review',
  tag,
  async ({browser, playwright, baseURL}) => {
    test.slow();
    const doc = await readyDocument(playwright, baseURL!, browser);
    const rev = await apiAs(playwright, baseURL!, userByRole('rev').email);
    const hit = await foundSoon(rev, doc.deedNo, doc.id);
    expect(hit).toMatchObject({status: 'intake', instrumentRef: doc.deedNo});
    await rev.dispose();

    const page = await signedInPage(
      browser,
      userByRole('rev').email,
      '/documents',
    );
    await page.getByLabel('Search documents').fill(doc.deedNo);
    const row = page.locator('button.drow', {hasText: doc.deedNo});
    await expect(row).toContainText('In intake');
    await expect(row).toContainText('Opens in Verify metadata');
    await evidence(
      page,
      'API-803',
      'Documents: a scan still in intake is found by its deed number, marked "In intake"; its row opens the review',
    );
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/verify\\?doc=${doc.id}`));
    await expect(page.locator('.doc-head')).toContainText(doc.deedNo);
    await evidence(
      page,
      'API-803',
      'The row opens the scan in Verify metadata, for the reviewer to review',
    );
    await page.context().close();
  },
);

test(
  'a user without intake read permission does not find a scan still in intake',
  tag,
  async ({browser, playwright, baseURL}) => {
    test.slow();
    const doc = await readyDocument(playwright, baseURL!, browser);
    const rev = await apiAs(playwright, baseURL!, userByRole('rev').email);
    await foundSoon(rev, doc.deedNo, doc.id);
    await rev.dispose();
    // the administrator reads filed documents (audit) but not intake's
    const adm = await apiAs(playwright, baseURL!, userByRole('adm').email);
    expect((await search(adm, doc.deedNo)).map(d => d.id)).not.toContain(
      doc.id,
    );
    await adm.dispose();

    // the same on the screen
    const page = await signedInPage(
      browser,
      userByRole('adm').email,
      '/documents',
    );
    const apiIdle = trackApi(page);
    // the administrator's start page (Users) may take over: Documents from the menu
    await page
      .getByRole('complementary', {name: 'Main navigation'})
      .getByRole('link', {name: 'Documents (EDRMS)'})
      .click();
    await expect(page.getByLabel('Search documents')).toBeVisible();
    await apiIdle();
    // read from the address, as the screen encodes it (a "/" in the deed number stays as it is)
    const searched = page.waitForResponse(
      r =>
        r.url().includes('/api/documents?') &&
        new URL(r.url()).searchParams.get('q') === doc.deedNo,
    );
    await page.getByLabel('Search documents').fill(doc.deedNo);
    await searched;
    await apiIdle();
    await expect(
      page.locator('button.drow', {hasText: doc.deedNo}),
    ).toHaveCount(0);
    await evidence(
      page,
      'API-803',
      'The administrator (no intake read permission) searches the deed number of a scan in intake: it is not found',
    );
    await page.context().close();
  },
);

test(
  'once filed, the same document is found with the corrected values, by them and by its reference',
  tag,
  async ({browser, playwright, baseURL}) => {
    test.slow();
    const doc = await readyDocument(
      playwright,
      baseURL!,
      browser,
      sampleDeed(),
    );
    const rev = await apiAs(playwright, baseURL!, userByRole('rev').email);
    const h = {headers: rev.headers};
    await foundSoon(rev, doc.deedNo, doc.id);

    // the reviewer corrects the transferee's name and files the deed
    const corrected = `Ndapewa Kxoeb${Math.random()
      .toString(36)
      .replace(/[^a-z]/g, '')
      .slice(0, 6)}`;
    await expect
      .poll(
        async () =>
          (
            await rev.api.post(`/api/intake/documents/${doc.id}/claim`, h)
          ).status(),
        {timeout: 20_000},
      )
      .toBe(200);
    expect(
      (
        await rev.api.post(`/api/intake/documents/${doc.id}/accept-clean`, h)
      ).status(),
    ).toBe(200);
    const detail = await (
      await rev.api.get(`/api/intake/documents/${doc.id}`, h)
    ).json();
    for (const f of detail.fields as Array<{k: string; status: string}>) {
      const change =
        f.k === 'tee1'
          ? {value: corrected}
          : f.status === 'pending'
            ? {status: 'accepted'}
            : null;
      if (!change) continue;
      const res = await rev.api.put(
        `/api/intake/documents/${doc.id}/fields/${f.k}`,
        {...h, data: change},
      );
      expect(res.status(), await res.text()).toBe(200);
    }
    const filed = await rev.api.post(`/api/intake/documents/${doc.id}/file`, h);
    expect(filed.status(), await filed.text()).toBe(200);
    const {filedDocumentId} = await filed.json();

    const byCorrected = await foundSoon(
      rev,
      corrected.split(' ')[1],
      filedDocumentId,
    );
    expect(byCorrected.status).toBe('filed');
    expect(byCorrected.fields.find(f => f.k === 'tee1')!.v).toBe(corrected);
    // one document, under its EDRMS id: no row left in intake
    await expect
      .poll(async () => (await search(rev, doc.deedNo)).map(d => d.id), {
        timeout: 20_000,
      })
      .toEqual([filedDocumentId]);
    await rev.dispose();

    // on the screen: found by the corrected name, filed, with the corrected value
    const page = await signedInPage(
      browser,
      userByRole('rev').email,
      '/documents',
    );
    const apiIdle = trackApi(page);
    await page.getByLabel('Search documents').fill(corrected.split(' ')[1]);
    const row = page.locator('button.drow', {hasText: byCorrected.edrmsNo});
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('In intake');
    await apiIdle();
    await row.click();
    await apiIdle();
    await expect(page.locator('.doc-head')).toContainText(byCorrected.edrmsNo);
    await expect(page.getByText(corrected).first()).toBeVisible();
    await evidence(
      page,
      'API-803',
      "A document once filed, found by the reviewer's corrected name, shows the corrected value",
    );
    await page.context().close();
  },
);
