/**
 * "Check this B/L" on a B/L's page (CB-47): each step of its chain of title checked in the browser
 * against the platform's keys of its proof file (`lrfe-title-proof/1`, the shipping pack's
 * docs/chain-of-title.md): linked to the step before, intact (its hash) and signed by the platform
 * (an ES256 signature over exactly its content); the blockchain status of the latest step; the
 * proof file's name and the command that checks it offline. The browser's own cryptography does
 * the checking; where a page is not served securely the browser has none, and the steps are only
 * said to be signed by the platform. Product wording, generic: no tool name. Tested by
 * bl-check.test.ts (`npm run test:shipping`).
 */
import type {ChainEntry} from './bl.model';

/** A public key of the platform, as its key set publishes it (a JWK). */
export interface PlatformJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid: string;
  alg?: string;
  use?: string;
}

/** The platform's key set: every version of its signing key. */
export interface Jwks {
  keys: PlatformJwk[];
}

/** An entry of the chain of title as the proof file carries it: signed and hashed. */
export interface SignedEntry extends ChainEntry {
  recordId: string;
  endorsement: string;
  documentHash: string;
  previousHash: string | null;
  kid: string;
  entryHash: string;
  signature: string;
}

/** A B/L's proof file, `lrfe-title-proof/1` (the fields the page reads). */
export interface TitleProof {
  format: string;
  recordId: string;
  recordNo: string;
  entries: SignedEntry[];
  jwks: Jwks;
  /** The proof of the latest step on the blockchain, `{pending: true}` before it is there. */
  anchor: unknown;
  latest: boolean;
  latestSeq: number;
  /** The B/L it was split from, whose last entry its first one follows. */
  parent?: {entries: SignedEntry[]};
}

/** How the proof's keys compare with the keys the platform publishes. */
export interface KeyCheck {
  state: 'match' | 'differ' | 'unknown';
  /** The fingerprint of the keys, when they match. */
  fingerprint: string | null;
}

/** How a step's signature stands: checked, not matching, or not checked by this browser. */
export type StepCheck = 'checked' | 'failed' | 'unchecked';

/** A step's check. */
export interface StepResult {
  seq: number;
  check: StepCheck;
}

/** Where the latest step stands on the blockchain. */
export interface ProofStatus {
  state: 'pending' | 'recorded' | 'confirmed';
  /** The words after "Proof on the blockchain:". */
  label: string;
  /** When it was confirmed, ISO 8601; null when not known. */
  at: string | null;
}

/** Structured blockchain anchoring details extracted from the proof's `anchor` (CB-77). */
export interface AnchorDetails {
  pending: boolean;
  status: 'pending' | 'recorded' | 'confirmed';
  batch: number | null;
  size: number | null;
  tx: string | null;
  txShort: string | null;
  explorerUrl: string | null;
  network: string | null;
  label: number | null;
  block: number | null;
  confirmations: number | null;
  confirmedAt: string | null;
  root: string | null;
  address: string | null;
}

/** The JWS type of a chain entry's signature. */
const ENTRY_TYP = 'lrfe-title-entry';

/** The signature's algorithm: ECDSA P-256 with SHA-256. */
const ENTRY_ALG = 'ES256';

/** The length of an ES256 signature: r and s, 32 bytes each. */
const SIGNATURE_LENGTH = 64;

/** The base64url alphabet of a JWS part. */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** What stands in the command for the blockchain address while it is not known. */
const ADDRESS_PLACEHOLDER = "<the platform's blockchain address>";

/** What stands in the command for the key fingerprint while it is not known. */
const KEY_PLACEHOLDER = "<the platform's key fingerprint>";

/**
 * JSON with object keys sorted at every level and no spaces, fields that are undefined left out:
 * what the platform hashes and signs (canonicalJson of the backend).
 * @param value the value
 * @return its canonical JSON
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort();
  const fields = keys.map(
    key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  );
  return `{${fields.join(',')}}`;
}

/**
 * The SHA-256 of a text, lowercase hex.
 * @param text the text
 * @param subtle the browser's cryptography
 * @return the hash
 */
async function sha256Hex(text: string, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * The bytes of a base64url text.
 * @param text the text
 * @return the bytes
 */
function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * An entry's content: the entry without its hash and signature, what both are made over.
 * @param entry the entry
 * @return its content
 */
function contentOf(entry: SignedEntry): Record<string, unknown> {
  const content: Record<string, unknown> = {...entry};
  delete content['entryHash'];
  delete content['signature'];
  return content;
}

/**
 * Whether a signature is the platform's: a compact JWS, ES256, of the chain entry type, made
 * with the key the entry names (found in the key set), over exactly the entry's content.
 * @param entry the entry
 * @param canonical its content's canonical JSON
 * @param jwks the key set
 * @param subtle the browser's cryptography
 * @return true when it is
 */
async function isSigned(
  entry: SignedEntry,
  canonical: string,
  jwks: Jwks,
  subtle: SubtleCrypto,
): Promise<boolean> {
  if (typeof entry.signature !== 'string') {
    return false;
  }
  const parts = entry.signature.split('.');
  if (parts.length !== 3 || !parts.every(part => BASE64URL.test(part))) {
    return false;
  }
  const [header, payload, signature] = parts;
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(fromBase64url(header)),
  );
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const {alg, kid, typ} = parsed as Record<string, unknown>;
  if (alg !== ENTRY_ALG || typ !== ENTRY_TYP || kid !== entry.kid) {
    return false;
  }
  if (new TextDecoder().decode(fromBase64url(payload)) !== canonical) {
    return false;
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const jwk = keys.find(key => key?.kid === kid);
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    return false;
  }
  const bytes = fromBase64url(signature);
  if (bytes.length !== SIGNATURE_LENGTH) {
    return false;
  }
  const key = await subtle.importKey(
    'jwk',
    {kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y},
    {name: 'ECDSA', namedCurve: 'P-256'},
    false,
    ['verify'],
  );
  return subtle.verify(
    {name: 'ECDSA', hash: 'SHA-256'},
    key,
    bytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

/** Where a step must sit: its place, the hash it follows and the B/L it is of. */
interface StepPlace {
  index: number;
  previousHash: string | null;
  recordId: string;
}

/**
 * Checks one step: of the B/L, linked to the one before, intact and signed. Never throws.
 * @param entry the step's entry
 * @param place its place in the chain (from 0), the hash it must follow and the B/L
 * @param jwks the key set
 * @param subtle the browser's cryptography
 * @return whether it holds
 */
async function checkStep(
  entry: SignedEntry,
  place: StepPlace,
  jwks: Jwks,
  subtle: SubtleCrypto,
): Promise<boolean> {
  try {
    const linked =
      entry.seq === place.index + 1 &&
      entry.previousHash === place.previousHash &&
      entry.recordId === place.recordId;
    if (!linked) {
      return false;
    }
    const canonical = canonicalJson(contentOf(entry));
    if ((await sha256Hex(canonical, subtle)) !== entry.entryHash) {
      return false;
    }
    return await isSigned(entry, canonical, jwks, subtle);
  } catch {
    // a part that is not base64url or JSON, a key the browser refuses: the step does not hold
    return false;
  }
}

/**
 * Checks each step of a chain of title, as the offline verifier does it for the chain and the
 * signatures: the B/L it is of, its place, its link to the step before (the first follows nothing, or for a B/L
 * made by a split its parent's split step), its hash, and the platform's signature with a key of
 * the key set. Without the browser's cryptography every step is unchecked. Never throws.
 * @param entries the chain, in its order
 * @param jwks the platform's key set, from the proof file
 * @param subtle the browser's cryptography, null where the page has none
 * @param options `recordId`: the B/L of the proof file, which every step must be of;
 *     `startPreviousHash`: what the first entry follows
 * @return each step's check, in the chain's order
 */
export async function checkSteps(
  entries: readonly SignedEntry[],
  jwks: Jwks,
  subtle: SubtleCrypto | null,
  {
    recordId,
    startPreviousHash = null,
  }: {recordId: string; startPreviousHash?: string | null},
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let previousHash = startPreviousHash;
  for (const [index, entry] of entries.entries()) {
    let check: StepCheck = 'unchecked';
    if (subtle !== null) {
      const place = {index, previousHash, recordId};
      const holds = await checkStep(entry, place, jwks, subtle);
      check = holds ? 'checked' : 'failed';
    }
    results.push({seq: entry.seq, check});
    previousHash = entry.entryHash;
  }
  return results;
}

/**
 * What a step's signature column says.
 * @param check the step's check
 * @return the words
 */
export function signatureLabel(check: StepCheck): string {
  switch (check) {
    case 'checked':
      return 'Signature checked';
    case 'failed':
      return 'Signature does not match';
    default:
      return 'Not checked in this browser';
  }
}

/**
 * What the check says of the whole chain; a warning when the proof's keys differ from the ones
 * the platform publishes, even though the signatures match them.
 * @param results each step's check
 * @param options `keysDiffer`: the keys differ (keyCheck)
 * @return one sentence
 */
export function checkSummary(
  results: readonly StepResult[],
  {keysDiffer = false}: {keysDiffer?: boolean} = {},
): string {
  const failed = results.filter(r => r.check === 'failed');
  if (failed.length > 0) {
    const steps = failed.map(r => r.seq).join(', ');
    if (failed.length === 1) {
      return `Step ${steps} does not match its signature: do not rely on this B/L. Tell the carrier.`;
    }
    return `Steps ${steps} do not match their signature: do not rely on this B/L. Tell the carrier.`;
  }
  if (results.some(r => r.check === 'unchecked')) {
    return 'Not checked in this browser: it cannot check signatures on a page that is not served securely. Check the proof offline.';
  }
  if (keysDiffer) {
    return 'Signatures checked against keys that differ from the ones this platform publishes: do not rely on this B/L until that is explained.';
  }
  if (results.length === 1) {
    return "The step carries the platform's signature, checked in your browser.";
  }
  if (results.length === 2) {
    return "Both steps carry the platform's signature, checked in your browser.";
  }
  return `All ${results.length} steps carry the platform's signature, checked in your browser.`;
}

/**
 * What the page says of a B/L made by a split: the chain of the B/L it was split from is checked
 * only offline, not in the browser.
 * @param parent the proof file's `parent`, absent for a B/L of its own
 * @return the note, or null
 */
export function splitNote(parent: TitleProof['parent']): string | null {
  if (parent === undefined) {
    return null;
  }
  return "This B/L was made by splitting another B/L: that B/L's chain of title is not checked in this browser, only by the offline check.";
}

/**
 * Where the latest step stands on the blockchain, from the proof file's `anchor`: pending until
 * it is written there, then written, then confirmed (with when).
 * @param anchor the proof file's anchor
 * @return its status
 */
export function proofStatus(anchor: unknown): ProofStatus {
  const proof = anchor !== null && typeof anchor === 'object' ? anchor : {};
  const {status, anchor: written} = proof as {
    status?: unknown;
    anchor?: {confirmedAt?: unknown} | null;
  };
  const confirmedAt = written?.confirmedAt;
  const at = typeof confirmedAt === 'string' ? confirmedAt : null;
  if (status === 'confirmed') {
    return {state: 'confirmed', label: 'confirmed', at};
  }
  if (status === 'anchored') {
    return {
      state: 'recorded',
      label: 'written, waiting for confirmation',
      at: null,
    };
  }
  return {state: 'pending', label: 'pending', at: null};
}

/**
 * Shortens a 64-char hex hash for display (`abcd1234…5678ef90`).
 * @param value the hash, or null
 * @return shortened hash or null
 */
function shortHex(value: string | null): string | null {
  if (value === null || value === '') {
    return null;
  }
  if (value.length <= 20) {
    return value;
  }
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

/** Extracts an optional non-empty string field. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Extracts an optional finite number field. */
function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Structured blockchain anchoring details from the proof's `anchor` (CB-77).
 * @param anchor the proof file's anchor object
 * @return structured fields ready for display in the portal
 */
export function anchorDetails(anchor: unknown): AnchorDetails {
  const status = proofStatus(anchor);
  const rawAnchor =
    anchor !== null && typeof anchor === 'object'
      ? (anchor as {anchor?: unknown}).anchor
      : null;
  const info =
    rawAnchor !== null && typeof rawAnchor === 'object'
      ? (rawAnchor as Record<string, unknown>)
      : null;
  if (status.state === 'pending' || info === null) {
    return {
      pending: true,
      status: 'pending',
      batch: null,
      size: null,
      tx: null,
      txShort: null,
      explorerUrl: null,
      network: null,
      label: null,
      block: null,
      confirmations: null,
      confirmedAt: null,
      root: null,
      address: null,
    };
  }
  const tx = optionalString(info['tx']);
  return {
    pending: false,
    status: status.state,
    batch: optionalNumber(info['batch']),
    size: optionalNumber(info['size']),
    tx,
    txShort: shortHex(tx),
    explorerUrl: optionalString(info['explorerUrl']),
    network: optionalString(info['network']),
    label: optionalNumber(info['label']),
    block: optionalNumber(info['block']),
    confirmations: optionalNumber(info['confirmations']),
    confirmedAt: optionalString(info['confirmedAt']),
    root: optionalString(info['root']),
    address: optionalString(info['address']),
  };
}

/**
 * The name the proof file is saved under: with the B/L's number, the characters a file name
 * cannot carry made dashes.
 * @param recordNo the B/L's number
 * @return the file name
 */
export function proofFileName(recordNo: string): string {
  const safe = recordNo.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safe === '') {
    return 'title-proof.json';
  }
  return `title-proof-${safe}.json`;
}

/**
 * The command that checks the proof file offline, with the platform's published wallet and key
 * fingerprint (placeholders while they are not known).
 * @param fileName the proof file
 * @param address the platform's blockchain address (its anchoring wallet)
 * @param fingerprint the key set's fingerprint
 * @return the command
 */
export function verifyCommand(
  fileName: string,
  address: string | null,
  fingerprint: string | null,
): string {
  const wallet = address ?? ADDRESS_PLACEHOLDER;
  const key = fingerprint ?? KEY_PLACEHOLDER;
  return `node lrfe-verify.mjs ${fileName} --address ${wallet} --title-key ${key}`;
}

/**
 * The fingerprint of the platform's key set, as the offline verifier pins it: SHA-256 hex of its
 * canonical JSON; null without the browser's cryptography.
 * @param jwks the key set
 * @param subtle the browser's cryptography, null where the page has none
 * @return the fingerprint
 */
export async function titleKeyFingerprint(
  jwks: Jwks,
  subtle: SubtleCrypto | null,
): Promise<string | null> {
  if (subtle === null) {
    return null;
  }
  return sha256Hex(canonicalJson(jwks), subtle);
}

/**
 * What the page says of the blockchain status: the platform's report, which the offline check
 * confirms independently.
 * @param status the status (proofStatus)
 * @param when when it was confirmed, as the page writes dates; null when not known
 * @return one or two sentences
 */
export function statusSentence(
  status: ProofStatus,
  when: string | null,
): string {
  switch (status.state) {
    case 'confirmed': {
      let on = '';
      if (when !== null) {
        on = ` on ${when}`;
      }
      return `The platform reports: confirmed on the blockchain${on}. The offline check confirms it independently.`;
    }
    case 'recorded':
      return 'The platform reports: written to the blockchain, waiting for confirmation. The offline check confirms it independently once it is confirmed.';
    default:
      return 'The platform reports: pending, not on the blockchain yet. The latest step goes there with the next recording; the offline check can confirm it after that.';
  }
}

/**
 * Compares the keys a proof file carries with the keys the platform publishes, by their
 * fingerprint: a proof signed with other keys must not be relied on.
 * @param proofKeys the keys of the proof file
 * @param published the keys the platform publishes, null when they cannot be read
 * @param subtle the browser's cryptography, null where the page has none
 * @return whether they match, with the fingerprint when they do
 */
export async function keyCheck(
  proofKeys: Jwks,
  published: Jwks | null,
  subtle: SubtleCrypto | null,
): Promise<KeyCheck> {
  if (published === null || subtle === null) {
    return {state: 'unknown', fingerprint: null};
  }
  const ofProof = await titleKeyFingerprint(proofKeys, subtle);
  const ofPlatform = await titleKeyFingerprint(published, subtle);
  if (ofProof !== ofPlatform) {
    return {state: 'differ', fingerprint: null};
  }
  return {state: 'match', fingerprint: ofPlatform};
}

/**
 * What the page says of the keys: whose they are, and how to check them independently.
 * @param check the comparison (keyCheck)
 * @return one or two sentences
 */
export function keyNote(check: KeyCheck): string {
  switch (check.state) {
    case 'match':
      return `Signed with the keys this platform publishes (fingerprint ${check.fingerprint}). For an independent check, compare this fingerprint with one you received another way, for example from the carrier.`;
    case 'differ':
      return 'The keys in this proof are not the keys this platform publishes: do not rely on this proof. Tell the carrier.';
    default:
      return 'The keys this platform publishes cannot be compared here now: check the proof offline.';
  }
}
