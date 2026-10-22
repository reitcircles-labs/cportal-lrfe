import {createHash} from 'node:crypto';
import {expect} from 'chai';
import {
  KeyringError,
  createEncryptingStore,
  createFakeKeyring,
  createMemoryStore,
} from '@lrfe/storage';
import {actor, committedErf1873, makeExtracts, users} from './helpers.js';

const rec = actor(users.rec);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The bytes stored under `key`, as they lie in the store. */
async function storedBytes(store, key) {
  const chunks = [];
  for await (const chunk of await store.getStream(key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Extracts over a store that encrypts under the key extracts-files (EXTRACTS_ENCRYPTION=fake). */
async function encrypted() {
  const plain = createMemoryStore();
  const keyring = createFakeKeyring({keyName: 'extracts-files'});
  const ctx = await makeExtracts({
    files: createEncryptingStore(plain, keyring),
  });
  const record = await committedErf1873(ctx.records);
  const extract = await ctx.service.issue(
    {
      recordId: record.id,
      versionNumber: 1,
      ownerIndex: 0,
      idNo: '75060200418',
      documentSeen: true,
    },
    rec,
  );
  return {...ctx, plain, keyring, record, extract};
}

describe('extract PDFs stored encrypted (API-780)', () => {
  it('stores ciphertext, keeps the wrapped key with the register row, and gives the same PDF again', async () => {
    const {plain, repo, service, extract} = await encrypted();
    const row = await repo.getExtract(extract.id);
    const stored = await storedBytes(plain, row.pdfKey);
    expect(stored.subarray(0, 4).toString()).to.equal('LRFE');
    expect(stored.includes(Buffer.from('%PDF'))).to.equal(false);
    expect(row.pdfEncryption).to.include({keyName: 'extracts-files'});
    expect(row.pdfEncryption.wrappedKey).to.match(/^fake:v1:/);

    // the register's SHA-256 stays the plain PDF's; download again gives those bytes, twice
    const first = (await service.pdf(extract.id)).pdf;
    const second = (await service.pdf(extract.id)).pdf;
    expect(first.subarray(0, 5).toString()).to.equal('%PDF-');
    expect(sha256(first)).to.equal(row.pdfSha256);
    expect(second.equals(first)).to.equal(true);
  });

  it('never shows where or how the PDF is stored', async () => {
    const {app, as, record, extract} = await encrypted();
    const res = await app.inject({
      url: `/extracts?recordId=${record.id}`,
      headers: as(users.rec),
    });
    expect(res.statusCode).to.equal(200);
    expect(res.body).to.include(extract.id);
    expect(res.body).to.not.match(/pdfEncryption|wrappedKey|pdfKey|fake:v1:/);
  });

  it('refuses with a neutral message when the key cannot be read, and gives nothing out', async () => {
    const {keyring, service, extract} = await encrypted();
    keyring.unwrap = async () => {
      throw new KeyringError('permission denied on extracts-files', 'EAUTH', {
        status: 403,
      });
    };
    const err = await service.pdf(extract.id).then(
      () => expect.fail('the download must be refused'),
      e => e,
    );
    expect(err.statusCode).to.equal(503);
    expect(err.message).to.equal(
      'The extract store is temporarily unavailable. Try again shortly.',
    );
    expect(err.message).to.not.match(/bao|vault|key/i);
    expect(err.cause.message).to.include('extracts-files');
  });

  it('a stored file that was changed is not given out', async () => {
    const {plain, repo, service, extract} = await encrypted();
    const row = await repo.getExtract(extract.id);
    const stored = await storedBytes(plain, row.pdfKey);
    stored[stored.length - 40] ^= 1;
    await plain.put({key: row.pdfKey, body: stored});
    const err = await service.pdf(extract.id).then(
      () => expect.fail('a changed file must not be given out'),
      e => e,
    );
    expect(err.statusCode).to.equal(500);
    expect(err.message).to.include('does not match the register');
  });
});
