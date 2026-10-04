import { readFile } from 'node:fs/promises';
import { createFakeKeyring } from './fake-keyring.js';

/**
 * Keyring backed by OpenBao (README.md sections 3 and 4): the service logs in with its own AppRole,
 * asks transit for a new data key per file and to unwrap stored ones. The KEK never leaves OpenBao.
 *
 *   const keyring = createBaoKeyring({ addr, roleId, secretIdFile, keyName: 'edrms-files' });
 *   const { plaintext, wrapped, keyName } = await keyring.newDataKey();   // wrapped = "vault:v1:…"
 *   const dek = await keyring.unwrap({ wrapped, keyName });
 *
 * Token: logged in on first use, renewed when 3/4 of its lifetime has passed, logged in again when
 * renewal fails or OpenBao refuses the token (an expired token and a key the policy does not allow
 * both answer 403; a 403 after a fresh login is "not allowed"). No background timers.
 *
 * Errors are KeyringError with a code:
 *   EUNAVAILABLE  sealed, unreachable, slow or failing (after retries): the services answer
 *                 "document store temporarily unavailable"; safe to retry later
 *   ELOGIN        the AppRole login was refused (wrong role ID or secret ID)
 *   EDENIED       the service may not use this key (its policy)
 *   EKEY          OpenBao rejected the request (e.g. not a wrapped key of this KEK)
 */

export class KeyringError extends Error {
    constructor(message, code, { status = null, cause } = {}) {
        super(message);
        this.name = 'KeyringError';
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function createBaoKeyring({
    addr, roleId, secretId, secretIdFile, keyName,
    timeoutMs = 5000, retries = 2, backoffMs = 200,
    fetch: fetchFn = globalThis.fetch, clock = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms))
}) {
    if (!addr) throw new Error('OpenBao keyring: the vault address (BAO_ADDR) is required');
    if (!roleId) throw new Error('OpenBao keyring: the AppRole role ID (BAO_ROLE_ID) is required');
    if (!secretId && !secretIdFile) throw new Error('OpenBao keyring: the AppRole secret ID (BAO_SECRET_ID_FILE) is required');
    if (!keyName) throw new Error('OpenBao keyring: the key name (BAO_KEY_NAME) is required');
    const base = addr.replace(/\/+$/, '');
    let token = null;          // { value, renewAt, renewable }
    let loggingIn = null;

    /** One HTTP call with timeout and retries on network errors, 429 and 5xx (including sealed). */
    async function call(path, { body, token: t } = {}) {
        for (let attempt = 0; ; attempt++) {
            let res, json;
            try {
                res = await fetchFn(`${base}/v1/${path}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(t ? { 'X-Vault-Token': t } : {}) },
                    body: JSON.stringify(body ?? {}),
                    signal: AbortSignal.timeout(timeoutMs)
                });
                json = await res.json().catch(() => ({}));
            } catch (err) {
                const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
                if (attempt < retries) { await sleep(backoffMs * 4 ** attempt); continue; }
                throw new KeyringError(slow ? `OpenBao did not answer within ${timeoutMs} ms` : `OpenBao unreachable: ${err?.message || err}`, 'EUNAVAILABLE', { cause: err });
            }
            if (res.ok) return json;
            const detail = (json.errors || []).join('; ').replace(/\s+/g, ' ').trim() || `HTTP ${res.status}`;
            if (RETRY_STATUS.has(res.status)) {
                if (attempt < retries) { await sleep(backoffMs * 4 ** attempt); continue; }
                throw new KeyringError(`OpenBao unavailable: ${detail}`, 'EUNAVAILABLE', { status: res.status });
            }
            return { failed: true, status: res.status, detail };
        }
    }

    async function login() {
        const sid = secretId ?? (await readFile(secretIdFile, 'utf8').catch(err => {
            throw new KeyringError(`Cannot read the AppRole secret ID file: ${err.message}`, 'ELOGIN', { cause: err });
        })).trim();
        const r = await call('auth/approle/login', { body: { role_id: roleId, secret_id: sid } });
        if (r.failed) throw new KeyringError(`OpenBao refused the AppRole login: ${r.detail}`, 'ELOGIN', { status: r.status });
        const a = r.auth;
        token = { value: a.client_token, renewable: !!a.renewable, renewAt: clock() + a.lease_duration * 1000 * 0.75 };
        return token.value;
    }

    /** A valid token: the current one, renewed when due, or a fresh login. Concurrent callers share one login. */
    async function currentToken() {
        if (token && clock() < token.renewAt) return token.value;
        if (token?.renewable) {
            const r = await call('auth/token/renew-self', { token: token.value });
            if (!r.failed) {
                token = { value: r.auth.client_token, renewable: !!r.auth.renewable, renewAt: clock() + r.auth.lease_duration * 1000 * 0.75 };
                return token.value;
            }
        }
        token = null;
        loggingIn ??= login().finally(() => { loggingIn = null; });
        return loggingIn;
    }

    /** A transit call; a 403 gets one fresh login and one retry before it counts as "not allowed". */
    async function transit(path, body) {
        let r = await call(path, { body, token: await currentToken() });
        if (r.failed && r.status === 403) {
            token = null;
            r = await call(path, { body, token: await currentToken() });
            if (r.failed && r.status === 403) throw new KeyringError(`This service may not use ${path} (OpenBao policy)`, 'EDENIED', { status: 403 });
        }
        if (r.failed) throw new KeyringError(`OpenBao rejected ${path}: ${r.detail}`, 'EKEY', { status: r.status });
        return r.data;
    }

    return {
        name: 'openbao',
        keyName,
        async newDataKey() {
            const d = await transit(`transit/datakey/plaintext/${encodeURIComponent(keyName)}`, { bits: 256 });
            const plaintext = Buffer.from(d.plaintext, 'base64');
            if (plaintext.length !== 32 || !/^vault:v\d+:/.test(d.ciphertext || '')) throw new KeyringError('OpenBao returned an unexpected data key', 'EKEY');
            return { plaintext, wrapped: d.ciphertext, keyName };
        },
        async unwrap({ wrapped, keyName: name = keyName }) {
            const d = await transit(`transit/decrypt/${encodeURIComponent(name)}`, { ciphertext: wrapped });
            const plaintext = Buffer.from(d.plaintext, 'base64');
            if (plaintext.length !== 32) throw new KeyringError('OpenBao returned an unexpected data key', 'EKEY');
            return plaintext;
        }
    };
}

/**
 * The keyring a service uses, from its settings; null when encryption is off.
 *   <setting>=off (default) | bao | fake
 *   bao:  BAO_ADDR, BAO_ROLE_ID, BAO_SECRET_ID_FILE, BAO_KEY_NAME (default: defaultKeyName)
 *   fake: in-memory keys, nothing sent (tests, the e2e stack); files cannot be read after a restart
 */
export function keyringFromEnv({ setting, defaultKeyName, env = process.env, ...options }) {
    const mode = (env[setting] || 'off').toLowerCase();
    if (mode === 'off') return null;
    const keyName = env.BAO_KEY_NAME || defaultKeyName;
    if (mode === 'fake') return createFakeKeyring({ keyName });
    if (mode !== 'bao') throw new Error(`${setting} must be off, bao or fake, got "${env[setting]}"`);
    return createBaoKeyring({ addr: env.BAO_ADDR, roleId: env.BAO_ROLE_ID, secretIdFile: env.BAO_SECRET_ID_FILE, keyName, ...options });
}
