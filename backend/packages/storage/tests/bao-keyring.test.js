import { expect } from 'chai';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBaoKeyring, createEncryptingStore, createMemoryStore, keyringFromEnv, KeyringError } from '../src/index.js';

/**
 * A small OpenBao stand-in answering as OpenBao 2.7.1 did when probed: AppRole login (400 for a
 * wrong secret ID), renew-self, transit datakey/decrypt ("vault:v1:…"), 403 "permission denied"
 * for an unknown or expired token and for a key outside the policy, 503 "Vault is sealed".
 */
async function fakeBao() {
    const kek = { 'edrms-files': randomBytes(32), 'intake-files': randomBytes(32) };
    const roles = { edrms: { roleId: 'role-edrms', secretId: 'secret-edrms', keys: ['edrms-files'] } };
    const tokens = new Map();     // token → { role, expires }
    const state = { sealed: false, now: 0, ttl: 3600, fail: [], delayMs: 0, calls: [] };
    const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const body = raw ? JSON.parse(raw) : {};
        const path = req.url.replace(/^\/v1\//, '');
        state.calls.push(path);
        if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
        if (state.fail.length) return send(res, state.fail.shift(), { errors: ['injected'] });
        if (state.sealed) return send(res, 503, { errors: ['Vault is sealed'] });
        if (path === 'auth/approle/login') {
            const role = Object.entries(roles).find(([, r]) => r.roleId === body.role_id && r.secretId === body.secret_id);
            if (!role) return send(res, 400, { errors: ['invalid role or secret ID'] });
            const t = `s.${randomUUID()}`;
            tokens.set(t, { role: role[0], expires: state.now + state.ttl * 1000 });
            return send(res, 200, { auth: { client_token: t, lease_duration: state.ttl, renewable: true, policies: ['default', ...role[1].keys] } });
        }
        const t = tokens.get(req.headers['x-vault-token']);
        if (!t || t.expires <= state.now) return send(res, 403, { errors: ['permission denied'] });
        if (path === 'auth/token/renew-self') {
            t.expires = state.now + state.ttl * 1000;
            return send(res, 200, { auth: { client_token: req.headers['x-vault-token'], lease_duration: state.ttl, renewable: true } });
        }
        const m = /^transit\/(datakey\/plaintext|decrypt)\/(.+)$/.exec(path);
        if (!m) return send(res, 404, { errors: ['no handler'] });
        const key = decodeURIComponent(m[2]);
        if (!roles[t.role].keys.includes(key)) return send(res, 403, { errors: ['1 error occurred:\n\t* permission denied\n\n'] });
        if (m[1] === 'datakey/plaintext') {
            const dek = randomBytes(body.bits / 8), iv = randomBytes(12);
            const c = createCipheriv('aes-256-gcm', kek[key], iv);
            const ct = Buffer.concat([iv, c.update(dek), c.final(), c.getAuthTag()]);
            return send(res, 200, { data: { plaintext: dek.toString('base64'), ciphertext: `vault:v1:${ct.toString('base64')}`, key_version: 1 } });
        }
        try {
            const raw = Buffer.from(String(body.ciphertext).replace(/^vault:v1:/, ''), 'base64');
            const d = createDecipheriv('aes-256-gcm', kek[key], raw.subarray(0, 12));
            d.setAuthTag(raw.subarray(raw.length - 16));
            const dek = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
            return send(res, 200, { data: { plaintext: dek.toString('base64') } });
        } catch { return send(res, 400, { errors: ['invalid ciphertext length'] }); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const addr = `http://127.0.0.1:${server.address().port}`;
    return { addr, state, tokens, close: () => new Promise(r => server.close(r)) };
}

describe('OpenBao keyring (AppRole)', () => {
    let bao;
    beforeEach(async () => { bao = await fakeBao(); });
    afterEach(() => bao.close());
    const keyring = (opts = {}) => createBaoKeyring({
        addr: bao.addr, roleId: 'role-edrms', secretId: 'secret-edrms', keyName: 'edrms-files',
        clock: () => bao.state.now, sleep: async () => {}, ...opts
    });
    const logins = () => bao.state.calls.filter(c => c === 'auth/approle/login').length;

    it('logs in on first use, gets a 32-byte data key and a wrapped key, and unwraps it', async () => {
        const k = keyring();
        expect(logins()).to.equal(0);
        const { plaintext, wrapped, keyName } = await k.newDataKey();
        expect(plaintext).to.have.length(32);
        expect(wrapped).to.match(/^vault:v1:/);
        expect(keyName).to.equal('edrms-files');
        expect((await k.unwrap({ wrapped, keyName })).equals(plaintext)).to.equal(true);
        expect(logins()).to.equal(1);
    });

    it('reuses the token, renews it after 3/4 of its lifetime, and logs in again when it cannot', async () => {
        const k = keyring();
        await k.newDataKey();
        bao.state.now += 2000 * 1000;                     // < 2700 s: no renewal yet
        await k.newDataKey();
        expect(bao.state.calls.filter(c => c.endsWith('renew-self'))).to.have.length(0);
        bao.state.now += 1000 * 1000;                     // 3000 s: renew
        await k.newDataKey();
        expect(bao.state.calls.filter(c => c.endsWith('renew-self'))).to.have.length(1);
        expect(logins()).to.equal(1);
        bao.state.now += 5000 * 1000;                     // token expired: renewal refused, login again
        await k.newDataKey();
        expect(logins()).to.equal(2);
    });

    it('logs in again once when OpenBao refuses the token (e.g. revoked)', async () => {
        const k = keyring();
        await k.newDataKey();
        bao.tokens.clear();
        await k.newDataKey();
        expect(logins()).to.equal(2);
    });

    it('a key outside the policy is "not allowed" (EDENIED), after one fresh login', async () => {
        const k = keyring();
        const { wrapped } = await k.newDataKey();
        const err = await k.unwrap({ wrapped, keyName: 'intake-files' }).catch(e => e);
        expect(err).to.be.instanceOf(KeyringError);
        expect(err.code).to.equal('EDENIED');
        expect(logins()).to.equal(2);
    });

    it('a sealed vault is EUNAVAILABLE after the retries', async () => {
        const k = keyring({ retries: 2 });
        bao.state.sealed = true;
        const err = await k.newDataKey().catch(e => e);
        expect(err.code).to.equal('EUNAVAILABLE');
        expect(err.message).to.contain('Vault is sealed');
        expect(bao.state.calls).to.have.length(3);
    });

    it('rides out a brief failure (503, 429) with retries', async () => {
        const k = keyring({ retries: 2 });
        bao.state.fail = [503, 429];
        expect((await k.newDataKey()).plaintext).to.have.length(32);
    });

    it('an unreachable or slow vault is EUNAVAILABLE', async () => {
        const unreachable = createBaoKeyring({ addr: 'http://127.0.0.1:9', roleId: 'r', secretId: 's', keyName: 'k', retries: 0 });
        expect((await unreachable.newDataKey().catch(e => e)).code).to.equal('EUNAVAILABLE');
        bao.state.delayMs = 200;
        const err = await keyring({ timeoutMs: 50, retries: 0 }).newDataKey().catch(e => e);
        expect(err.code).to.equal('EUNAVAILABLE');
        expect(err.message).to.contain('did not answer within 50 ms');
    });

    it('a wrong secret ID is ELOGIN', async () => {
        const err = await keyring({ secretId: 'wrong' }).newDataKey().catch(e => e);
        expect(err.code).to.equal('ELOGIN');
        expect(err.message).to.contain('invalid role or secret ID');
    });

    it('reads the secret ID from a file at login time', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lrfe-bao-'));
        try {
            const file = join(dir, 'secret-id');
            await writeFile(file, 'secret-edrms\n', { mode: 0o600 });
            const k = createBaoKeyring({ addr: bao.addr, roleId: 'role-edrms', secretIdFile: file, keyName: 'edrms-files', sleep: async () => {} });
            expect((await k.newDataKey()).plaintext).to.have.length(32);
            const missing = createBaoKeyring({ addr: bao.addr, roleId: 'role-edrms', secretIdFile: join(dir, 'none'), keyName: 'edrms-files' });
            expect((await missing.newDataKey().catch(e => e)).code).to.equal('ELOGIN');
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('a value that is not a wrapped key of this KEK is EKEY', async () => {
        const err = await keyring().unwrap({ wrapped: 'vault:v1:AAAA', keyName: 'edrms-files' }).catch(e => e);
        expect(err.code).to.equal('EKEY');
    });

    it('several files at once share one login', async () => {
        const k = keyring();
        await Promise.all([k.newDataKey(), k.newDataKey(), k.newDataKey()]);
        expect(logins()).to.equal(1);
    });

    it('encrypts and decrypts files through the encrypting store', async () => {
        const inner = createMemoryStore();
        const store = createEncryptingStore(inner, keyring());
        const plain = randomBytes(200_000);
        const r = await store.put({ key: 'docs/1/v1/deed.pdf', body: plain });
        expect(r.encryption.wrappedKey).to.match(/^vault:v1:/);
        expect(r.encryption.keyName).to.equal('edrms-files');
        const chunks = [];
        for await (const c of await store.getStream('docs/1/v1/deed.pdf', { encryption: r.encryption })) chunks.push(c);
        expect(Buffer.concat(chunks).equals(plain)).to.equal(true);
    });

    describe('startup check', () => {
        const checking = (opts = {}) => createBaoKeyring({ addr: bao.addr, roleId: 'role-edrms', secretId: 'secret-edrms', keyName: 'edrms-files', retries: 0, ...opts });

        it('passes at once when the vault is ready', async () => {
            await checking().check({ waitMs: 1000, intervalMs: 20 });
            expect(bao.state.calls).to.include('transit/datakey/plaintext/edrms-files');
        });

        it('waits for a vault that is still sealed (starting up), then passes', async () => {
            bao.state.sealed = true;
            setTimeout(() => { bao.state.sealed = false; }, 150);
            const t0 = Date.now();
            await checking().check({ waitMs: 3000, intervalMs: 30 });
            expect(Date.now() - t0).to.be.within(100, 3000);
        });

        it('gives up after the wait with a clear message', async () => {
            bao.state.sealed = true;
            const err = await checking().check({ waitMs: 200, intervalMs: 30 }).catch(e => e);
            expect(err.code).to.equal('EUNAVAILABLE');
            expect(err.message).to.match(new RegExp(`^OpenBao at ${bao.addr} is sealed or unreachable \\(waited 0 s\\): .*Vault is sealed`));
        });

        it('a refused login or key fails at once, without waiting', async () => {
            let t0 = Date.now();
            expect((await checking({ secretId: 'wrong' }).check({ waitMs: 5000, intervalMs: 1000 }).catch(e => e)).code).to.equal('ELOGIN');
            expect(Date.now() - t0).to.be.below(900);
            t0 = Date.now();
            expect((await checking({ keyName: 'intake-files' }).check({ waitMs: 5000, intervalMs: 1000 }).catch(e => e)).code).to.equal('EDENIED');
            expect(Date.now() - t0).to.be.below(900);
        });

        it('the fake keyring always passes', async () => {
            await keyringFromEnv({ setting: 'X', defaultKeyName: 'k', env: { X: 'fake' } }).check();
        });
    });

    it('refuses to start without its settings', () => {
        expect(() => createBaoKeyring({ roleId: 'r', secretId: 's', keyName: 'k' })).to.throw('BAO_ADDR');
        expect(() => createBaoKeyring({ addr: 'x', secretId: 's', keyName: 'k' })).to.throw('BAO_ROLE_ID');
        expect(() => createBaoKeyring({ addr: 'x', roleId: 'r', keyName: 'k' })).to.throw('BAO_SECRET_ID_FILE');
        expect(() => createBaoKeyring({ addr: 'x', roleId: 'r', secretId: 's' })).to.throw('BAO_KEY_NAME');
    });
});

describe('keyring settings', () => {
    it('off by default; fake on request; OpenBao with its settings', () => {
        expect(keyringFromEnv({ setting: 'EDRMS_ENCRYPTION', defaultKeyName: 'edrms-files', env: {} })).to.equal(null);
        expect(keyringFromEnv({ setting: 'EDRMS_ENCRYPTION', defaultKeyName: 'edrms-files', env: { EDRMS_ENCRYPTION: 'off' } })).to.equal(null);
        const fake = keyringFromEnv({ setting: 'EDRMS_ENCRYPTION', defaultKeyName: 'edrms-files', env: { EDRMS_ENCRYPTION: 'fake' } });
        expect(fake).to.include({ name: 'fake', keyName: 'edrms-files' });
        const bao = keyringFromEnv({ setting: 'EDRMS_ENCRYPTION', defaultKeyName: 'edrms-files', env: { EDRMS_ENCRYPTION: 'bao', BAO_ADDR: 'http://127.0.0.1:8200', BAO_ROLE_ID: 'r', BAO_SECRET_ID_FILE: '/x' } });
        expect(bao).to.include({ name: 'openbao', keyName: 'edrms-files' });
        expect(() => keyringFromEnv({ setting: 'EDRMS_ENCRYPTION', env: { EDRMS_ENCRYPTION: 'yes' } })).to.throw('off, bao or fake');
        expect(() => keyringFromEnv({ setting: 'EDRMS_ENCRYPTION', defaultKeyName: 'k', env: { EDRMS_ENCRYPTION: 'bao' } })).to.throw('BAO_ADDR');
    });
});
