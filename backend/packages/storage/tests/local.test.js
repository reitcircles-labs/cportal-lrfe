import {expect} from 'chai';
import {existsSync} from 'node:fs';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createLocalStore} from '../src/index.js';

const put = (store, key) =>
  store.put({key, body: Readable.from([Buffer.from(`content of ${key}`)])});

describe('local store', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'local-store-'));
  });
  afterEach(() => rm(root, {recursive: true, force: true}));

  it('a delete removes the folders it leaves empty, never the root or a folder still in use (API-807)', async () => {
    const store = createLocalStore({root});
    await put(store, 'intake/doc-a/v1/scan.pdf');
    await put(store, 'intake/doc-a/v1/transcription-1.json');
    await put(store, 'intake/doc-b/v1/scan.pdf');

    await store.delete('intake/doc-a/v1/scan.pdf');
    expect(existsSync(join(root, 'intake/doc-a/v1'))).to.equal(true);
    await store.delete('intake/doc-a/v1/transcription-1.json');
    expect(existsSync(join(root, 'intake/doc-a'))).to.equal(false);
    expect(await readdir(join(root, 'intake'))).to.deep.equal(['doc-b']);

    await store.delete('intake/doc-b/v1/scan.pdf');
    expect(await readdir(root)).to.deep.equal([]);
    // deleting what is gone is fine, and a later put makes the folders again
    await store.delete('intake/doc-b/v1/scan.pdf');
    await put(store, 'intake/doc-b/v1/scan.pdf');
    expect(existsSync(join(root, 'intake/doc-b/v1/scan.pdf'))).to.equal(true);
  });

  it('a put into a folder that a delete removes meanwhile still lands', async () => {
    const store = createLocalStore({root});
    await put(store, 'edrms/doc/v1/a.pdf');
    await Promise.all([
      store.delete('edrms/doc/v1/a.pdf'),
      put(store, 'edrms/doc/v1/b.pdf'),
    ]);
    expect(existsSync(join(root, 'edrms/doc/v1/b.pdf'))).to.equal(true);
  });
});
