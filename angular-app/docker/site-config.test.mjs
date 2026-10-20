// Unit tests for the web container's startup script (API-712): `npm run test:site-config`.
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';

const SCRIPT = join(import.meta.dirname, 'site-config.sh');
const dir = mkdtempSync(join(tmpdir(), 'site-config-'));
after(() => rmSync(dir, {recursive: true, force: true}));

/**
 * Runs the script with only these settings and returns the file it wrote, parsed. With this
 * machine's sh; the image's is busybox, where the same cases were checked by hand (API-712).
 */
function written(settings) {
  const file = join(dir, `${Object.keys(settings).join('-') || 'none'}.json`);
  execFileSync('sh', [SCRIPT], {
    env: {PATH: process.env.PATH, SITE_CONFIG_FILE: file, ...settings},
    stdio: 'ignore',
  });
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('site-config.sh', () => {
  it('writes each setting, escaped for JSON', () => {
    assert.deepEqual(
      written({
        LRFE_ORG_NAME: 'Land "Titles" \\ Office',
        LRFE_ORG_SUBTITLE: 'Republic · é',
        LRFE_ORG_PARENT: 'Ministry',
        LRFE_ORG_PLACE: 'Testville',
      }),
      {
        orgName: 'Land "Titles" \\ Office',
        orgSubtitle: 'Republic · é',
        orgParent: 'Ministry',
        orgPlace: 'Testville',
      },
    );
  });

  it('turns tabs and line breaks into spaces', () => {
    assert.deepEqual(written({LRFE_ORG_NAME: 'Land\tTitles\nOffice'}), {
      orgName: 'Land Titles Office',
    });
  });

  it('writes a setting that is set but empty, and leaves out one that is not set', () => {
    assert.deepEqual(written({LRFE_ORG_SUBTITLE: ''}), {orgSubtitle: ''});
    assert.deepEqual(written({}), {});
  });
});
