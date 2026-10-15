// Unit tests for the site's organisation settings (API-712): `npm run test:site-config`.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_SITE_CONFIG, fullName, loadSiteConfig, nameAndPlace, parseSiteConfig } from './site-config.ts';

const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('site config', () => {
  it("takes the site's texts, trimmed", () => {
    const config = parseSiteConfig({ orgName: ' Land Titles Office ', orgSubtitle: 'Republic of Testland', orgParent: 'Ministry of Lands', orgPlace: 'Testville' });
    assert.deepEqual(config, { orgName: 'Land Titles Office', orgSubtitle: 'Republic of Testland', orgParent: 'Ministry of Lands', orgPlace: 'Testville' });
    assert.equal(fullName(config), 'Land Titles Office · Republic of Testland');
    assert.equal(nameAndPlace(config), 'Land Titles Office · Testville');
  });

  it('an empty text stays empty and is left out; an empty name gets the default', () => {
    const config = parseSiteConfig({ orgName: '', orgSubtitle: '', orgParent: ' ', orgPlace: '' });
    assert.deepEqual(config, { orgName: 'Deeds Registry', orgSubtitle: '', orgParent: '', orgPlace: '' });
    assert.equal(fullName(config), 'Deeds Registry');
    assert.equal(nameAndPlace(config), 'Deeds Registry');
  });

  it('a missing or wrong setting gets the default', () => {
    assert.deepEqual(parseSiteConfig({ orgName: 'X', orgPlace: 42 }), { ...DEFAULT_SITE_CONFIG, orgName: 'X' });
    assert.deepEqual(parseSiteConfig(null), DEFAULT_SITE_CONFIG);
    assert.deepEqual(parseSiteConfig('text'), DEFAULT_SITE_CONFIG);
  });

  it('loads the file, and starts with the defaults when it is missing or broken', async () => {
    assert.equal((await loadSiteConfig(reply(200, '{"orgName":"Land Titles Office"}'))).orgName, 'Land Titles Office');
    assert.deepEqual(await loadSiteConfig(reply(404, 'not found')), DEFAULT_SITE_CONFIG);
    assert.deepEqual(await loadSiteConfig(reply(200, '{ broken')), DEFAULT_SITE_CONFIG);
    assert.deepEqual(await loadSiteConfig((async () => { throw new TypeError('network'); }) as unknown as typeof fetch), DEFAULT_SITE_CONFIG);
  });
});
