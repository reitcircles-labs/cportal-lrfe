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
  return JSON.parse(readFileSync(run(settings).config, 'utf8'));
}

/** Runs the script with only these settings; returns the paths of the two files it writes. */
function run(settings) {
  const name = Object.entries(settings).flat().join('-').replace(/\W/g, '_');
  const config = join(dir, `${name || 'none'}.json`);
  const origins = join(dir, `${name || 'none'}.conf`);
  execFileSync('sh', [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      SITE_CONFIG_FILE: config,
      DOCUMENT_ORIGINS_FILE: origins,
      ...settings,
    },
    stdio: 'ignore',
  });
  return {config, origins};
}

/** The document origins the script allows in the content security policy (API-822). */
function origins(settings) {
  const text = readFileSync(run(settings).origins, 'utf8');
  return text.match(/default "([^"]*)";/)[1];
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

  it('allows no other document origin with local storage', () => {
    assert.equal(origins({}), '');
    assert.equal(
      origins({
        EDRMS_STORAGE: 'local',
        AWS_BUCKET_NAME: 'b',
        AWS_BUCKET_REGION: 'r',
      }),
      '',
    );
  });

  it("allows the S3 bucket's origin for documents stored in S3", () => {
    const s3 = {EDRMS_STORAGE: 's3', AWS_BUCKET_REGION: 'af-south-1'};
    assert.equal(
      origins({...s3, AWS_BUCKET_NAME: 'deeds-files'}),
      'https://deeds-files.s3.af-south-1.amazonaws.com',
    );
    // a name with dots is signed on the region's host
    assert.equal(
      origins({...s3, AWS_BUCKET_NAME: 'deeds.files'}),
      'https://s3.af-south-1.amazonaws.com',
    );
  });

  it('writes nothing into nginx from a bucket or region that is not a valid name', () => {
    assert.equal(
      origins({
        EDRMS_STORAGE: 's3',
        AWS_BUCKET_NAME: 'x"; add_header X 1; #',
        AWS_BUCKET_REGION: 'af-south-1',
      }),
      '',
    );
  });
});
