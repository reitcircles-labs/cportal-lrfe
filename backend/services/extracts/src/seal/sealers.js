import {
  KeyObject,
  X509Certificate,
  createHash,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  webcrypto,
} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import {AppError} from '@lrfe/common';
import {pemToDer} from './cms.js';

/**
 * A Sealer applies the registry's organisation seal (README.md, "The seal"):
 *   kind              'bao' (the key in OpenBao) | 'test' (an in-process key, never at a site)
 *   certificate()     → the seal certificate, DER
 *   sign(bytes)       → the signature of `bytes` (the CMS signed attributes) with the seal's key:
 *                       ECDSA as DER, or RSA PKCS #1 v1.5, always over SHA-256
 */

/** Why issuing is refused while no seal is set up: shown to staff, so no settings named. */
export const NO_SEAL_MESSAGE =
  'Extracts cannot be issued yet: the registry’s electronic seal is not set up. Tell the administrator.';

/** The message staff see when the seal cannot be applied now; the cause is logged. */
const SEAL_FAILED_MESSAGE =
  'The registry’s electronic seal cannot be applied now: try again later. If it keeps failing, tell the administrator.';

/** A seal failure: 503 for staff with a neutral message, the cause kept for the log. */
function sealFailed(cause) {
  const err = new AppError(503, SEAL_FAILED_MESSAGE);
  err.cause = cause;
  return err;
}

/** The public key of a certificate, or of a PEM public key, as SPKI DER, for comparing. */
const spkiOf = key =>
  key.export({type: 'spki', format: 'der'}).toString('base64');

/**
 * An in-process seal for the unit tests and for development and the e2e stack without a vault:
 * a P-256 key made at start and a self-signed certificate that says it is a test seal. Never used
 * with NODE_ENV=production (sealerFromEnv).
 */
export async function createTestSealer({name = 'Test registry'} = {}) {
  const {publicKey, privateKey} = await webcrypto.subtle.generateKey(
    {name: 'ECDSA', namedCurve: 'P-256'},
    false,
    ['sign', 'verify'],
  );
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({
    // positive: the first bit clear
    valueHex: new Uint8Array([0x01, ...randomBytes(15)]).buffer,
  });
  const commonName = new pkijs.AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1js.Utf8String({value: `${name} (test seal, not valid)`}),
  });
  certificate.subject.typesAndValues.push(commonName);
  certificate.issuer.typesAndValues.push(commonName);
  const now = Date.now();
  certificate.notBefore.value = new Date(now - 24 * 3600 * 1000);
  certificate.notAfter.value = new Date(now + 10 * 365 * 24 * 3600 * 1000);
  // digitalSignature and nonRepudiation (contentCommitment): a seal
  const keyUsage = new asn1js.BitString({
    valueHex: new Uint8Array([0xc0]).buffer,
    unusedBits: 6,
  });
  certificate.extensions = [
    new pkijs.Extension({
      extnID: '2.5.29.15',
      critical: true,
      extnValue: keyUsage.toBER(false),
      parsedValue: keyUsage,
    }),
  ];
  await certificate.subjectPublicKeyInfo.importKey(publicKey);
  await certificate.sign(privateKey, 'SHA-256');
  const der = Buffer.from(certificate.toSchema().toBER());
  const nodeKey = KeyObject.from(privateKey);
  return {
    kind: 'test',
    async certificate() {
      return der;
    },
    async sign(bytes) {
      return cryptoSign('sha256', bytes, {key: nodeKey, dsaEncoding: 'der'});
    },
  };
}

/** The transit key types a seal can use, and how transit is asked to sign with each. */
const KEY_TYPES = {
  'ecdsa-p256': {marshaling_algorithm: 'asn1'},
  'rsa-2048': {signature_algorithm: 'pkcs1v15'},
  'rsa-3072': {signature_algorithm: 'pkcs1v15'},
  'rsa-4096': {signature_algorithm: 'pkcs1v15'},
};

/**
 * The seal's key in OpenBao's transit engine (type ecdsa-p256 or rsa-*, never exportable), as the
 * audit service's wallet key (audit/src/cardano/signer.js): the extracts service logs in with its
 * own AppRole and has transit sign the SHA-256 digest of the signed attributes (prehashed): neither
 * the key nor the PDF leaves where it is. `certificatePem` is the registry's seal certificate for
 * that key: the signature is made with the key version whose public key is the certificate's,
 * found again whenever the key is rotated (checkedKey).
 */
export function createBaoSealer({
  addr,
  roleId,
  secretIdFile,
  keyName,
  certificatePem,
  fetch: fetchFn = globalThis.fetch,
  timeoutMs = 5000,
}) {
  for (const [value, setting] of [
    [addr, 'BAO_ADDR'],
    [roleId, 'BAO_ROLE_ID'],
    [secretIdFile, 'BAO_SECRET_ID_FILE'],
    [keyName, 'EXTRACTS_SEAL_KEY'],
    [certificatePem, 'EXTRACTS_SEAL_CERT or EXTRACTS_SEAL_CERT_FILE'],
  ]) {
    if (!value) {
      throw new Error(`The seal's key is in OpenBao: ${setting} is required`);
    }
  }
  const certificateDer = pemToDer(certificatePem);
  const certificateKey = spkiOf(new X509Certificate(certificateDer).publicKey);
  const base = addr.replace(/\/+$/, '');
  let token = null;
  let renewAt = 0;
  let checked = null; // {type, version, latest}: the key version the certificate is for

  async function call(method, path, body, withToken = token) {
    let res;
    try {
      res = await fetchFn(`${base}/v1/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(withToken ? {'X-Vault-Token': withToken} : {}),
        },
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw sealFailed(new Error(`OpenBao is unreachable (${err.message})`));
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = sealFailed(
        new Error(
          `OpenBao answered ${res.status} for ${path}: ${(json.errors || []).join('; ') || 'no detail'}`,
        ),
      );
      err.vaultStatus = res.status;
      throw err;
    }
    return json;
  }

  async function login() {
    let secretId;
    try {
      secretId = (await readFile(secretIdFile, 'utf8')).trim();
    } catch (err) {
      throw sealFailed(
        new Error(
          `The extracts service's OpenBao secret ID cannot be read (${err.code}): ${secretIdFile}`,
        ),
      );
    }
    const {auth} = await call(
      'POST',
      'auth/approle/login',
      {role_id: roleId, secret_id: secretId},
      null,
    );
    token = auth.client_token;
    renewAt = Date.now() + auth.lease_duration * 750; // log in again after 3/4 of the lifetime
  }

  /** A call with a valid token; one fresh login when OpenBao refuses the token. */
  async function authed(method, path, body) {
    if (!token || Date.now() > renewAt) await login();
    try {
      return await call(method, path, body);
    } catch (err) {
      if (err.vaultStatus !== 403) throw err;
      await login();
      return call(method, path, body);
    }
  }

  /**
   * The key's type and the version of it the certificate is for. Read on every seal: the version
   * found is checked again only when the key's latest version has changed (it was rotated), and
   * the signature is always made with that version (key_version), never with a newer one the
   * certificate is not for.
   */
  async function checkedKey() {
    const {data} = await authed('GET', `transit/keys/${keyName}`);
    if (checked?.latest === data.latest_version) return checked;
    if (!KEY_TYPES[data.type]) {
      throw sealFailed(
        new Error(
          `OpenBao key ${keyName} is ${data.type}: a seal needs ecdsa-p256 or rsa-2048/3072/4096`,
        ),
      );
    }
    const version = Object.entries(data.keys ?? {})
      .filter(([, key]) => key?.public_key)
      .find(
        ([, key]) => spkiOf(createPublicKey(key.public_key)) === certificateKey,
      )?.[0];
    if (!version) {
      checked = null;
      throw sealFailed(
        new Error(
          `The seal certificate is for no version of OpenBao key ${keyName} (latest version ${data.latest_version}): set the certificate for the key`,
        ),
      );
    }
    checked = {
      type: data.type,
      version: Number(version),
      latest: data.latest_version,
    };
    return checked;
  }

  return {
    kind: 'bao',
    async certificate() {
      return certificateDer;
    },
    async sign(bytes) {
      const key = await checkedKey();
      const digest = createHash('sha256').update(bytes).digest();
      const {data} = await authed('POST', `transit/sign/${keyName}`, {
        input: digest.toString('base64'),
        prehashed: true,
        hash_algorithm: 'sha2-256',
        key_version: key.version,
        ...KEY_TYPES[key.type],
      });
      return Buffer.from(data.signature.split(':').pop(), 'base64');
    },
  };
}

/**
 * The seal from the settings: EXTRACTS_SEAL=bao, the key in OpenBao (createBaoSealer, with
 * BAO_ADDR, BAO_ROLE_ID, BAO_SECRET_ID_FILE, EXTRACTS_SEAL_KEY and the certificate as PEM in
 * EXTRACTS_SEAL_CERT or a file EXTRACTS_SEAL_CERT_FILE). Not set: the test seal outside production,
 * and none with NODE_ENV=production: issuing is then refused (NO_SEAL_MESSAGE).
 * @return {!Promise<?Object>} the Sealer, or null
 */
export async function sealerFromEnv({env = process.env, name} = {}) {
  const mode = (env.EXTRACTS_SEAL || '').trim();
  if (mode === 'bao') {
    const certificatePem =
      env.EXTRACTS_SEAL_CERT ||
      (env.EXTRACTS_SEAL_CERT_FILE
        ? await readFile(env.EXTRACTS_SEAL_CERT_FILE, 'utf8')
        : '');
    return createBaoSealer({
      addr: env.BAO_ADDR,
      roleId: env.BAO_ROLE_ID,
      secretIdFile: env.BAO_SECRET_ID_FILE,
      keyName: env.EXTRACTS_SEAL_KEY || 'extracts-seal',
      certificatePem,
    });
  }
  if (mode) {
    throw new Error(`EXTRACTS_SEAL must be bao or not set, got "${mode}"`);
  }
  if (env.NODE_ENV === 'production') return null;
  return createTestSealer({name});
}
