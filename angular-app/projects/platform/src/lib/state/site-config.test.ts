// Unit tests for the site's organisation settings (API-712): `npm run test:site-config`.
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  fullName,
  loadSiteConfig,
  nameAndPlace,
  parseSiteConfig,
  type SiteConfig,
} from './site-config.ts';

/** A product's defaults (each product gives its own in its ProductConfig). */
const DEFAULT_SITE_CONFIG: SiteConfig = {
  orgName: 'Records Office',
  orgSubtitle: 'Republic of Example',
  orgParent: 'Ministry of Examples',
  orgPlace: 'Example City',
};

const reply = (status: number, body: string) =>
  (async () => new Response(body, {status})) as unknown as typeof fetch;

describe('site config', () => {
  it("takes the site's texts, trimmed", () => {
    const config = parseSiteConfig(
      {
        orgName: ' Titles Office ',
        orgSubtitle: 'Republic of Testland',
        orgParent: 'Ministry of Records',
        orgPlace: 'Testville',
      },
      DEFAULT_SITE_CONFIG,
    );
    assert.deepEqual(config, {
      orgName: 'Titles Office',
      orgSubtitle: 'Republic of Testland',
      orgParent: 'Ministry of Records',
      orgPlace: 'Testville',
    });
    assert.equal(fullName(config), 'Titles Office · Republic of Testland');
    assert.equal(nameAndPlace(config), 'Titles Office · Testville');
  });

  it('an empty text stays empty and is left out; an empty name gets the default', () => {
    const config = parseSiteConfig(
      {
        orgName: '',
        orgSubtitle: '',
        orgParent: ' ',
        orgPlace: '',
      },
      DEFAULT_SITE_CONFIG,
    );
    assert.deepEqual(config, {
      orgName: DEFAULT_SITE_CONFIG.orgName,
      orgSubtitle: '',
      orgParent: '',
      orgPlace: '',
    });
    assert.equal(fullName(config), DEFAULT_SITE_CONFIG.orgName);
    assert.equal(nameAndPlace(config), DEFAULT_SITE_CONFIG.orgName);
  });

  it('a missing or wrong setting gets the default', () => {
    assert.deepEqual(
      parseSiteConfig({orgName: 'X', orgPlace: 42}, DEFAULT_SITE_CONFIG),
      {
        ...DEFAULT_SITE_CONFIG,
        orgName: 'X',
      },
    );
    assert.deepEqual(
      parseSiteConfig(null, DEFAULT_SITE_CONFIG),
      DEFAULT_SITE_CONFIG,
    );
    assert.deepEqual(
      parseSiteConfig('text', DEFAULT_SITE_CONFIG),
      DEFAULT_SITE_CONFIG,
    );
  });

  it('loads the file, and starts with the defaults when it is missing or broken', async () => {
    assert.equal(
      (
        await loadSiteConfig(
          DEFAULT_SITE_CONFIG,
          reply(200, '{"orgName":"Titles Office"}'),
        )
      ).orgName,
      'Titles Office',
    );
    assert.deepEqual(
      await loadSiteConfig(DEFAULT_SITE_CONFIG, reply(404, 'not found')),
      DEFAULT_SITE_CONFIG,
    );
    assert.deepEqual(
      await loadSiteConfig(DEFAULT_SITE_CONFIG, reply(200, '{ broken')),
      DEFAULT_SITE_CONFIG,
    );
    assert.deepEqual(
      await loadSiteConfig(DEFAULT_SITE_CONFIG, (async () => {
        throw new TypeError('network');
      }) as unknown as typeof fetch),
      DEFAULT_SITE_CONFIG,
    );
  });
});
