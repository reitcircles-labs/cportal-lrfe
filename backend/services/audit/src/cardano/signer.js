import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CardanoError } from './tx.js';

/**
 * The anchoring wallet's key (README.md section 3). In OpenBao's transit engine (type ed25519, not
 * exportable): the audit service logs in with its own AppRole, reads the public key, and has each
 * transaction's 32-byte body hash signed (`transit/sign/<key>`). It never sees the private key.
 *
 *   publicKey()  → 32-byte Buffer
 *   sign(hash)   → 64-byte Ed25519 signature
 */
export function createTransitSigner({ addr, roleId, secretIdFile, keyName = 'audit-anchor', fetch: fetchFn = globalThis.fetch, timeoutMs = 5000 }) {
    for (const [v, name] of [[addr, 'BAO_ADDR'], [roleId, 'BAO_ROLE_ID'], [secretIdFile, 'BAO_SECRET_ID_FILE']]) {
        if (!v) throw new CardanoError(`The anchoring wallet's key is in OpenBao: ${name} is required`, 'ECONFIG');
    }
    const base = addr.replace(/\/+$/, '');
    let token = null, renewAt = 0, publicKey = null;

    async function call(method, path, body, t = token) {
        let res;
        try {
            res = await fetchFn(`${base}/v1/${path}`, {
                method, headers: { 'Content-Type': 'application/json', ...(t ? { 'X-Vault-Token': t } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err) {
            throw new CardanoError(`OpenBao is unreachable (${err.message})`, 'ESIGN', { cause: err });
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new CardanoError(`OpenBao answered ${res.status} for ${path}: ${(json.errors || []).join('; ') || 'no detail'}`, 'ESIGN');
            err.status = res.status;
            throw err;
        }
        return json;
    }

    async function login() {
        const secretId = await readFile(secretIdFile, 'utf8').then(s => s.trim(), (err) => {
            throw new CardanoError(`The audit service's OpenBao secret ID cannot be read (${err.code}): ${secretIdFile}`, 'ECONFIG');
        });
        const auth = (await call('POST', 'auth/approle/login', { role_id: roleId, secret_id: secretId }, null).catch((err) => {
            // a wrong role ID or secret ID: waiting does not help
            if (err.status === 400) throw new CardanoError('OpenBao refused the audit service\'s login: check BAO_ROLE_ID and BAO_SECRET_ID_FILE', 'ECONFIG');
            throw err;
        })).auth;
        token = auth.client_token;
        renewAt = Date.now() + auth.lease_duration * 750;     // log in again after 3/4 of the lifetime
    }

    /** A call with a valid token; one fresh login when OpenBao refuses the token. */
    async function authed(method, path, body) {
        if (!token || Date.now() > renewAt) await login();
        try {
            return await call(method, path, body);
        } catch (err) {
            if (err.status !== 403) throw err;
            await login();
            return call(method, path, body);
        }
    }

    return {
        async publicKey() {
            if (publicKey) return publicKey;
            const { data } = await authed('GET', `transit/keys/${keyName}`);
            if (data.type !== 'ed25519') throw new CardanoError(`OpenBao key ${keyName} is ${data.type}, not ed25519`, 'ECONFIG');
            publicKey = Buffer.from(data.keys[String(data.latest_version)].public_key, 'base64');
            return publicKey;
        },
        async sign(hash) {
            const { data } = await authed('POST', `transit/sign/${keyName}`, { input: Buffer.from(hash).toString('base64') });
            const signature = Buffer.from(data.signature.split(':').pop(), 'base64');
            if (signature.length !== 64) throw new CardanoError(`OpenBao returned a ${signature.length}-byte signature, not 64`, 'ESIGN');
            return signature;
        }
    };
}

/** A key held in memory: tests only. */
export function createLocalSigner() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    return {
        nodePublicKey: publicKey,
        async publicKey() { return raw; },
        async sign(hash) { return edSign(null, Buffer.from(hash), privateKey); }
    };
}
