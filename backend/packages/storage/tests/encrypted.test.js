import { expect } from 'chai';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
    createEncryptingStore, createFakeKeyring, createLocalStore, createMemoryStore,
    cipherSizeOf, DecryptionError, ALG, FORMAT, DEFAULT_CHUNK_SIZE
} from '../src/index.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
async function readAll(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}
/** Feed a buffer in uneven pieces, as a network upload would. */
const pieces = (buf, size = 7777) => Readable.from((function* () { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); })());

function setup({ chunkSize = 16 } = {}) {
    const inner = createMemoryStore();
    const keyring = createFakeKeyring({ keyName: 'edrms-files' });
    return { inner, keyring, store: createEncryptingStore(inner, keyring, { chunkSize }) };
}
const stored = (inner, key) => inner.blobs.get(key).data;
/** Replace the stored bytes, then try to read. */
async function readTampered(ctx, key, encryption, change) {
    ctx.inner.blobs.get(key).data = change(Buffer.from(stored(ctx.inner, key)));
    return readAll(await ctx.store.getStream(key, { encryption }));
}

describe('encrypting store (chunked AES-256-GCM)', () => {
    for (const [label, size] of [['an empty file', 0], ['1 byte', 1], ['exactly one chunk', 16], ['one chunk and a byte', 17], ['three and a half chunks', 56]]) {
        it(`round trip: ${label}`, async () => {
            const ctx = setup();
            const plain = randomBytes(size);
            const r = await ctx.store.put({ key: 'k', body: plain, contentType: 'application/pdf' });
            expect(r.sha256).to.equal(sha(plain));
            expect(r.size).to.equal(size);
            expect(r.encryption.cipherSize).to.equal(cipherSizeOf(size, 16));
            expect(await readAll(await ctx.store.getStream('k', { encryption: r.encryption }))).to.deep.equal(plain);
        });
    }

    it('round trip of a 5 MB file fed in uneven pieces, with the default chunk size', async () => {
        const inner = createMemoryStore();
        const store = createEncryptingStore(inner, createFakeKeyring());
        const plain = randomBytes(5 * 1024 * 1024 + 123);
        const r = await store.put({ key: 'big', body: pieces(plain) });
        expect(r.encryption.chunkSize).to.equal(DEFAULT_CHUNK_SIZE);
        expect(r.sha256).to.equal(sha(plain));
        expect(sha(await readAll(await store.getStream('big', { encryption: r.encryption })))).to.equal(sha(plain));
    });

    it('stores only ciphertext, and returns what the record must keep', async () => {
        const ctx = setup();
        const plain = Buffer.from('DEED OF TRANSFER No. T 2210/2008 · Erf 1873, Klein Windhoek · Petrus Nghishidi 72110800345');
        const r = await ctx.store.put({ key: 'k', body: plain, contentType: 'application/pdf' });
        const bytes = stored(ctx.inner, 'k');
        expect(bytes.includes(Buffer.from('T 2210/2008'))).to.equal(false);
        expect(bytes.includes(Buffer.from('72110800345'))).to.equal(false);
        expect(bytes.subarray(0, 4).toString()).to.equal('LRFE');
        expect(ctx.inner.blobs.get('k').contentType).to.equal('application/octet-stream');
        expect(r.encryption).to.include({ alg: ALG, format: FORMAT, keyName: 'edrms-files', chunkSize: 16, cipherSha256: sha(bytes), cipherSize: bytes.length });
        expect(r.encryption.wrappedKey).to.match(/^fake:v1:/);
    });

    it('a new data key per file: the same file twice gives different ciphertext', async () => {
        const ctx = setup();
        const plain = randomBytes(100);
        const a = await ctx.store.put({ key: 'a', body: plain });
        const b = await ctx.store.put({ key: 'b', body: plain });
        expect(a.sha256).to.equal(b.sha256);
        expect(a.encryption.wrappedKey).to.not.equal(b.encryption.wrappedKey);
        expect(stored(ctx.inner, 'a').equals(stored(ctx.inner, 'b'))).to.equal(false);
    });

    describe('fails instead of returning altered content', () => {
        const plain = randomBytes(56);          // 4 chunks of 16 (the last one 8)
        const H = 20, F = 16 + 16;              // header size, ciphertext chunk size
        let ctx, r;
        beforeEach(async () => {
            ctx = setup();
            r = await ctx.store.put({ key: 'k', body: plain });
        });
        const expectFailure = async (change) => {
            const err = await readTampered(ctx, 'k', r.encryption, change).catch(e => e);
            expect(err).to.be.instanceOf(DecryptionError);
        };

        it('one changed byte in a chunk', () => expectFailure(b => { b[H + F + 3] ^= 1; return b; }));
        it('one changed byte in a tag', () => expectFailure(b => { b[b.length - 1] ^= 1; return b; }));
        it('two chunks swapped', () => expectFailure(b => Buffer.concat([b.subarray(0, H), b.subarray(H + F, H + 2 * F), b.subarray(H, H + F), b.subarray(H + 2 * F)])));
        it('the last chunk cut off (at a chunk boundary)', () => expectFailure(b => b.subarray(0, H + 3 * F)));
        it('cut off in the middle of a chunk', () => expectFailure(b => b.subarray(0, H + F + 5)));
        it('bytes appended', () => expectFailure(b => Buffer.concat([b, randomBytes(20)])));
        it('the chunk size in the header changed', () => expectFailure(b => { b.writeUInt32BE(32, 8); return b; }));
        it('the nonce prefix in the header changed', () => expectFailure(b => { b[15] ^= 1; return b; }));
        it('only the header left', () => expectFailure(b => b.subarray(0, H)));
        it('not an encrypted file at all', async () => {
            const err = await readTampered(ctx, 'k', r.encryption, () => Buffer.from('%PDF-1.7 plain')).catch(e => e);
            expect(err).to.be.instanceOf(DecryptionError);
            expect(err.message).to.contain('no LRFE header');
        });
    });

    it('a wrapped key from another keyring, or for another KEK, is refused', async () => {
        const ctx = setup();
        const r = await ctx.store.put({ key: 'k', body: randomBytes(40) });
        const other = createEncryptingStore(ctx.inner, createFakeKeyring({ keyName: 'edrms-files' }), { chunkSize: 16 });
        expect((await other.getStream('k', { encryption: r.encryption }).catch(e => e)).code).to.equal('EKEY');
        const intake = createEncryptingStore(ctx.inner, createFakeKeyring({ keyName: 'intake-files' }), { chunkSize: 16 });
        expect((await intake.getStream('k', { encryption: r.encryption }).catch(e => e)).message).to.contain('edrms-files is not available');
    });

    it('a file stored before encryption (no encryption record) is read as it is', async () => {
        const ctx = setup();
        const plain = Buffer.from('%PDF-1.7 stored before encryption');
        await ctx.inner.put({ key: 'old', body: plain });
        expect(await readAll(await ctx.store.getStream('old'))).to.deep.equal(plain);
    });

    it('refuses an encryption record it does not know', async () => {
        const ctx = setup();
        const r = await ctx.store.put({ key: 'k', body: randomBytes(10) });
        expect((await ctx.store.getStream('k', { encryption: { ...r.encryption, format: 2 } }).catch(e => e)).message).to.contain('Unsupported encryption');
    });

    it('erases the plain data key once a file is written and once it is read', async () => {
        const ctx = setup();
        const seen = [];
        const spy = {
            newDataKey: async () => { const k = await ctx.keyring.newDataKey(); seen.push(k.plaintext); return k; },
            unwrap: async (x) => { const k = await ctx.keyring.unwrap(x); seen.push(k); return k; }
        };
        const store = createEncryptingStore(ctx.inner, spy, { chunkSize: 16 });
        const r = await store.put({ key: 'k', body: randomBytes(50) });
        await readAll(await store.getStream('k', { encryption: r.encryption }));
        await new Promise(res => setImmediate(res));
        expect(seen).to.have.length(2);
        for (const k of seen) expect(k.equals(Buffer.alloc(32))).to.equal(true);
    });

    it('gives no direct links (they would hand out ciphertext); deletes through the inner store', async () => {
        const ctx = setup();
        await ctx.store.put({ key: 'k', body: randomBytes(10) });
        expect(await ctx.store.signedUrl('k', { expiresIn: 60, fileName: 'x.pdf', contentType: 'application/pdf' })).to.equal(null);
        await ctx.store.delete('k');
        expect(ctx.inner.blobs.has('k')).to.equal(false);
        expect(ctx.store.kind).to.equal('encrypted-memory');
    });

    it('works over the local folder store', async () => {
        const root = await mkdtemp(join(tmpdir(), 'lrfe-enc-'));
        try {
            const store = createEncryptingStore(createLocalStore({ root }), createFakeKeyring(), { chunkSize: 1024 });
            const plain = randomBytes(10_000);
            const r = await store.put({ key: 'docs/1/v1/deed.pdf', body: pieces(plain, 999) });
            expect(await readAll(await store.getStream('docs/1/v1/deed.pdf', { encryption: r.encryption }))).to.deep.equal(plain);
            // the local store still refuses to overwrite a version
            expect(await store.put({ key: 'docs/1/v1/deed.pdf', body: plain }).catch(e => e.code)).to.equal('EEXIST');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('a failing upload stream fails the write', async () => {
        const ctx = setup();
        const broken = new Readable({ read() { this.destroy(new Error('connection reset')); } });
        expect((await ctx.store.put({ key: 'k', body: broken }).catch(e => e)).message).to.equal('connection reset');
    });
});
