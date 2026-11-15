// Unit tests for "Check this B/L" on a B/L's page (CB-47): each step of the chain of title checked
// in the browser (its link, its hash and the platform's signature, with the keys of the proof
// file), the blockchain status of the latest step, the proof file's name and the command that
// checks it offline (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {createHash, webcrypto} from 'node:crypto';
import {describe, it} from 'node:test';

import {
  canonicalJson,
  checkSteps,
  checkSummary,
  splitNote,
  keyCheck,
  keyNote,
  proofFileName,
  proofStatus,
  signatureLabel,
  statusSentence,
  titleKeyFingerprint,
  verifyCommand,
  type Jwks,
  type SignedEntry,
  type StepCheck,
} from './bl-check.ts';
// the platform's own signer, as shipping-records signs the chain entries
import {
  createLocalSigner,
  signJws,
} from '../../../../../../backend/packages/common/src/jws.js';
// the offline verifier anyone runs on the downloaded proof: the browser must agree with it
import {titleKeyFingerprint as verifierFingerprint} from '../../../../../../backend/services/audit/verifier/lrfe-verify.mjs';

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

/** A platform key: its private half to sign, its public half in a key set. */
interface PlatformKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: Jwks['keys'][number];
}

/**
 * Makes a P-256 platform key, as the title signer has.
 * @param kid its key id
 * @return the key
 */
async function platformKey(kid: string): Promise<PlatformKey> {
  const pair = (await subtle.generateKey(
    {name: 'ECDSA', namedCurve: 'P-256'},
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = await subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: exported.x as string,
      y: exported.y as string,
      kid,
      alg: 'ES256',
      use: 'sig',
    },
  };
}

/**
 * Text as base64url, as a compact JWS has its parts.
 * @param text the text
 * @return base64url
 */
function base64url(text: string | Uint8Array): string {
  return Buffer.from(text).toString('base64url');
}

/**
 * Signs an entry's content as shipping-records does (docs/chain-of-title.md): its hash, and a
 * compact ES256 JWS of type lrfe-title-entry over its canonical JSON.
 * @param content the entry without entryHash and signature
 * @param key the key that signs
 * @param header what the JWS header says, when a test changes it
 * @return the entry
 */
async function signed(
  content: Omit<SignedEntry, 'entryHash' | 'signature'>,
  key: PlatformKey,
  header: Record<string, unknown> = {
    alg: 'ES256',
    kid: key.kid,
    typ: 'lrfe-title-entry',
  },
): Promise<SignedEntry> {
  const canonical = canonicalJson(content);
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(canonical)}`;
  const signature = new Uint8Array(
    await subtle.sign(
      {name: 'ECDSA', hash: 'SHA-256'},
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return {
    ...content,
    entryHash: createHash('sha256').update(canonical).digest('hex'),
    signature: `${signingInput}.${base64url(signature)}`,
  };
}

/**
 * An entry's content: without its hash and signature, as it is signed.
 * @param entry the entry
 * @return its content
 */
function contentOf(
  entry: SignedEntry,
): Omit<SignedEntry, 'entryHash' | 'signature'> {
  const content: Partial<SignedEntry> = {...entry};
  delete content.entryHash;
  delete content.signature;
  return content as Omit<SignedEntry, 'entryHash' | 'signature'>;
}

/** The organisations of the journey. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';

/**
 * A chain of title signed with a key: issue to the shipper, endorsement to the bank, then the
 * steps given.
 * @param key the platform key
 * @param startPreviousHash what the first entry follows (a split child's parent)
 * @return the entries
 */
async function journey(
  key: PlatformKey,
  startPreviousHash: string | null = null,
): Promise<SignedEntry[]> {
  const first = await signed(
    {
      recordId: 'rec-1',
      seq: 1,
      command: startPreviousHash === null ? 'issue' : 'issue-from-split',
      actor: {id: 'u-1', name: 'Carrier clerk', org: CARRIER},
      from: null,
      to: SHIPPER,
      endorsement: 'none',
      documentHash: 'ab'.repeat(32),
      at: '2026-11-14T08:00:00.000Z',
      previousHash: startPreviousHash,
      kid: key.kid,
    },
    key,
  );
  const second = await signed(
    {
      recordId: 'rec-1',
      seq: 2,
      command: 'endorse',
      actor: {id: 'u-2', name: 'Shipper clerk', org: SHIPPER},
      from: SHIPPER,
      to: BANK,
      endorsement: 'named',
      documentHash: 'ab'.repeat(32),
      at: '2026-11-14T09:00:00.000Z',
      previousHash: first.entryHash,
      kid: key.kid,
    },
    key,
  );
  return [first, second];
}

/**
 * The checks of a chain, step by step.
 * @param entries the chain
 * @param jwks the key set
 * @param startPreviousHash what the first entry follows
 * @return each step's check, in order
 */
async function checksOf(
  entries: SignedEntry[],
  jwks: Jwks,
  startPreviousHash: string | null = null,
): Promise<StepCheck[]> {
  const results = await checkSteps(entries, jwks, subtle, {
    recordId: 'rec-1',
    startPreviousHash,
  });
  return results.map(r => r.check);
}

describe('the canonical JSON the platform hashes and signs', () => {
  it('sorts the keys at every level, with no spaces', () => {
    assert.equal(
      canonicalJson({b: 1, a: {d: [3, {f: true, e: null}], c: 'x'}}),
      '{"a":{"c":"x","d":[3,{"e":null,"f":true}]},"b":1}',
    );
  });

  it('leaves out undefined fields and escapes strings as JSON does', () => {
    assert.equal(canonicalJson({a: undefined, b: 'q"é\n'}), '{"b":"q\\"é\\n"}');
  });
});

describe("each step of the chain, checked in the browser with the proof file's keys", () => {
  it('a genuine chain: every step checked', async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    assert.deepEqual(await checksOf(entries, {keys: [key.jwk]}), [
      'checked',
      'checked',
    ]);
  });

  it('each result names its step', async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    const results = await checkSteps(entries, {keys: [key.jwk]}, subtle, {
      recordId: 'rec-1',
    });
    assert.deepEqual(
      results.map(r => r.seq),
      [1, 2],
    );
  });

  it('a step whose content was changed after signing fails; the others stay checked', async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    entries[1] = {...entries[1], to: 'org-thief'};
    assert.deepEqual(await checksOf(entries, {keys: [key.jwk]}), [
      'checked',
      'failed',
    ]);
  });

  it('a step re-hashed after a change still fails: its signature is over the old content', async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    const changed = {...contentOf(entries[1]), to: 'org-thief'};
    entries[1] = {
      ...changed,
      entryHash: createHash('sha256')
        .update(canonicalJson(changed))
        .digest('hex'),
      signature: entries[1].signature,
    };
    assert.deepEqual(await checksOf(entries, {keys: [key.jwk]}), [
      'checked',
      'failed',
    ]);
  });

  it('a step signed with a key outside the key set fails', async () => {
    const key = await platformKey('bl-title:v1');
    const other = await platformKey('bl-title:v1');
    const entries = await journey(other);
    assert.deepEqual(await checksOf(entries, {keys: [key.jwk]}), [
      'failed',
      'failed',
    ]);
  });

  it('a step whose key id is not in the key set fails', async () => {
    const key = await platformKey('bl-title:v2');
    const entries = await journey(key);
    const jwks = {keys: [{...key.jwk, kid: 'bl-title:v1'}]};
    assert.deepEqual(await checksOf(entries, jwks), ['failed', 'failed']);
  });

  it('a signature of another type, or another algorithm, fails', async () => {
    const key = await platformKey('bl-title:v1');
    const [entry] = await journey(key);
    const content = contentOf(entry);
    const otherType = await signed(content, key, {
      alg: 'ES256',
      kid: key.kid,
      typ: 'JWT',
    });
    const otherAlg = await signed(content, key, {
      alg: 'none',
      kid: key.kid,
      typ: 'lrfe-title-entry',
    });
    assert.deepEqual(await checksOf([otherType], {keys: [key.jwk]}), [
      'failed',
    ]);
    assert.deepEqual(await checksOf([otherAlg], {keys: [key.jwk]}), ['failed']);
  });

  it('a signature naming another key than the entry fails', async () => {
    const key = await platformKey('bl-title:v1');
    const [entry] = await journey(key);
    const content = contentOf(entry);
    const relabelled = await signed(content, key, {
      alg: 'ES256',
      kid: key.kid,
      typ: 'lrfe-title-entry',
    });
    relabelled.kid = 'bl-title:v9';
    assert.deepEqual(await checksOf([relabelled], {keys: [key.jwk]}), [
      'failed',
    ]);
  });

  it('a malformed signature fails, and the check never throws', async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    for (const signature of [
      '',
      'a.b',
      'x.y.z',
      '!!.??.**',
      42 as unknown as string,
    ]) {
      const broken = [{...entries[0], signature}];
      assert.deepEqual(
        await checksOf(broken, {keys: [key.jwk]}),
        ['failed'],
        String(signature),
      );
    }
  });

  it('a key set that is not one fails every step, and never throws', async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    for (const jwks of [
      null,
      {},
      {keys: 'x'},
      {keys: [{kid: key.kid, kty: 'RSA'}]},
    ]) {
      assert.deepEqual(
        await checksOf(entries, jwks as unknown as Jwks),
        ['failed', 'failed'],
        JSON.stringify(jwks),
      );
    }
  });

  it('steps out of order, or one missing in the middle, fail where the link breaks', async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    assert.deepEqual(
      await checksOf([entries[1], entries[0]], {keys: [key.jwk]}),
      ['failed', 'failed'],
    );
    assert.deepEqual(await checksOf([entries[1]], {keys: [key.jwk]}), [
      'failed',
    ]);
  });

  it("a B/L made by a split: its first step follows its parent's split step", async () => {
    const key = await platformKey('bl-title:v1');
    const parentSplit = 'cd'.repeat(32);
    const entries = await journey(key, parentSplit);
    assert.deepEqual(await checksOf(entries, {keys: [key.jwk]}, parentSplit), [
      'checked',
      'checked',
    ]);
    assert.deepEqual(await checksOf(entries, {keys: [key.jwk]}), [
      'failed',
      'checked',
    ]);
  });

  it('every signature checked with the right one of several key versions', async () => {
    const v1 = await platformKey('bl-title:v1');
    const v2 = await platformKey('bl-title:v2');
    const [first] = await journey(v1);
    const second = await signed(
      {
        recordId: 'rec-1',
        seq: 2,
        command: 'endorse',
        actor: {id: 'u-2', name: 'Shipper clerk', org: SHIPPER},
        from: SHIPPER,
        to: BANK,
        endorsement: 'named',
        documentHash: 'ab'.repeat(32),
        at: '2026-11-14T09:00:00.000Z',
        previousHash: first.entryHash,
        kid: v2.kid,
      },
      v2,
    );
    assert.deepEqual(
      await checksOf([first, second], {keys: [v1.jwk, v2.jwk]}),
      ['checked', 'checked'],
    );
  });

  it('an empty chain has no steps to check', async () => {
    assert.deepEqual(
      await checkSteps([], {keys: []}, subtle, {recordId: 'rec-1'}),
      [],
    );
  });

  it('a step of another B/L, signed and linked, fails (added: review, as the verifier checks it)', async () => {
    const key = await platformKey('bl-title:v1');
    const [first] = await journey(key);
    const other = await signed(
      {
        recordId: 'rec-other',
        seq: 2,
        command: 'endorse',
        actor: {id: 'u-2', name: 'Shipper clerk', org: SHIPPER},
        from: SHIPPER,
        to: BANK,
        endorsement: 'named',
        documentHash: 'ab'.repeat(32),
        at: '2026-11-14T09:00:00.000Z',
        previousHash: first.entryHash,
        kid: key.kid,
      },
      key,
    );
    assert.deepEqual(await checksOf([first, other], {keys: [key.jwk]}), [
      'checked',
      'failed',
    ]);
  });

  it("a chain signed by the platform's own signer is checked (added: review, fixture from signJws)", async () => {
    const signer = await createLocalSigner();
    const kid = await signer.currentKid();
    const entries: SignedEntry[] = [];
    let previousHash: string | null = null;
    for (const [index, to] of [SHIPPER, BANK].entries()) {
      const content = {
        recordId: 'rec-1',
        seq: index + 1,
        command: index === 0 ? 'issue' : 'endorse',
        actor: {id: 'u-1', name: 'Clerk', org: CARRIER},
        from: index === 0 ? null : SHIPPER,
        to,
        endorsement: index === 0 ? 'none' : 'named',
        documentHash: 'ab'.repeat(32),
        at: '2026-11-14T08:00:00.000Z',
        previousHash,
        kid,
      };
      const signature: string = await signJws(content, signer, {
        typ: 'lrfe-title-entry',
        kid,
      });
      const entryHash = createHash('sha256')
        .update(canonicalJson(content))
        .digest('hex');
      entries.push({...content, entryHash, signature});
      previousHash = entryHash;
    }
    assert.deepEqual(await checksOf(entries, await signer.jwks()), [
      'checked',
      'checked',
    ]);
  });

  it("without the browser's cryptography (a page not served securely): every step unchecked", async () => {
    const key = await platformKey('bl-title:v1');
    const entries = await journey(key);
    const results = await checkSteps(entries, {keys: [key.jwk]}, null, {
      recordId: 'rec-1',
    });
    assert.deepEqual(
      results.map(r => r.check),
      ['unchecked', 'unchecked'],
    );
  });
});

describe('what a step and the whole check say', () => {
  it("a step's signature: checked, does not match, or signed by the platform when not checked", () => {
    assert.equal(signatureLabel('checked'), 'Signature checked');
    assert.equal(signatureLabel('failed'), 'Signature does not match');
    assert.equal(signatureLabel('unchecked'), 'Not checked in this browser');
  });

  it('the summary: all checked', () => {
    const results = [
      {seq: 1, check: 'checked' as const},
      {seq: 2, check: 'checked' as const},
    ];
    assert.equal(
      checkSummary(results),
      "Both steps carry the platform's signature, checked in your browser.",
    );
  });

  it('the summary: all of more than two checked (added: second review)', () => {
    const results = [1, 2, 3].map(seq => ({seq, check: 'checked' as const}));
    assert.equal(
      checkSummary(results),
      "All 3 steps carry the platform's signature, checked in your browser.",
    );
  });

  it("the summary when the proof's keys differ from the published ones (added: second review)", () => {
    const results = [
      {seq: 1, check: 'checked' as const},
      {seq: 2, check: 'checked' as const},
    ];
    assert.equal(
      checkSummary(results, {keysDiffer: true}),
      'Signatures checked against keys that differ from the ones this platform publishes: do not rely on this B/L until that is explained.',
    );
  });

  it('the summary: one step', () => {
    assert.equal(
      checkSummary([{seq: 1, check: 'checked'}]),
      "The step carries the platform's signature, checked in your browser.",
    );
  });

  it('the summary names the steps that do not match', () => {
    const results = [
      {seq: 1, check: 'checked' as const},
      {seq: 2, check: 'failed' as const},
      {seq: 3, check: 'failed' as const},
    ];
    assert.equal(
      checkSummary(results),
      'Steps 2, 3 do not match their signature: do not rely on this B/L. Tell the carrier.',
    );
  });

  it('the summary when the browser cannot check', () => {
    assert.equal(
      checkSummary([{seq: 1, check: 'unchecked'}]),
      'Not checked in this browser: it cannot check signatures on a page that is not served securely. Check the proof offline.',
    );
  });
});

describe('the blockchain status of the latest step', () => {
  it('pending while it waits for the next batch', () => {
    assert.deepEqual(proofStatus({pending: true}), {
      state: 'pending',
      label: 'pending',
      at: null,
    });
  });

  it('confirmed, with when, from the proof', () => {
    assert.deepEqual(
      proofStatus({
        status: 'confirmed',
        anchor: {tx: 'ef'.repeat(32), confirmedAt: '2026-11-14T10:00:00.000Z'},
      }),
      {state: 'confirmed', label: 'confirmed', at: '2026-11-14T10:00:00.000Z'},
    );
  });

  it('confirmed without a time', () => {
    assert.deepEqual(proofStatus({status: 'confirmed', anchor: {}}), {
      state: 'confirmed',
      label: 'confirmed',
      at: null,
    });
  });

  it('written but not confirmed yet', () => {
    assert.deepEqual(
      proofStatus({status: 'anchored', anchor: {confirmedAt: null}}),
      {
        state: 'recorded',
        label: 'written, waiting for confirmation',
        at: null,
      },
    );
  });

  it('anything else reads as pending', () => {
    for (const anchor of [null, undefined, {}, {status: 'waiting'}, 'x']) {
      assert.equal(
        proofStatus(anchor).state,
        'pending',
        JSON.stringify(anchor),
      );
    }
  });
});

describe('the proof file and the offline check', () => {
  it("the file is named with the B/L's number", () => {
    assert.equal(proofFileName('CB47ABC123'), 'title-proof-CB47ABC123.json');
  });

  it('characters a file name cannot carry become dashes', () => {
    assert.equal(proofFileName('AB/12 x:?*'), 'title-proof-AB-12-x---.json');
    assert.equal(proofFileName(''), 'title-proof.json');
  });

  it("the command names the file, the platform's wallet and the key fingerprint", () => {
    assert.equal(
      verifyCommand('title-proof-X1.json', 'addr_test1xyz', 'ab'.repeat(32)),
      `node lrfe-verify.mjs title-proof-X1.json --address addr_test1xyz --title-key ${'ab'.repeat(32)}`,
    );
  });

  it('placeholders while the wallet or the fingerprint is not known', () => {
    assert.equal(
      verifyCommand('title-proof-X1.json', null, null),
      "node lrfe-verify.mjs title-proof-X1.json --address <the platform's blockchain address> --title-key <the platform's key fingerprint>",
    );
  });

  it("the key fingerprint is the verifier's: SHA-256 of the key set's canonical JSON", async () => {
    const key = await platformKey('bl-title:v1');
    const jwks = {keys: [key.jwk]};
    const fingerprint = await titleKeyFingerprint(jwks, subtle);
    assert.equal(fingerprint, verifierFingerprint(jwks));
    assert.match(fingerprint ?? '', /^[0-9a-f]{64}$/);
  });

  it("no fingerprint without the browser's cryptography", async () => {
    assert.equal(await titleKeyFingerprint({keys: []}, null), null);
  });
});

describe('what the page says of the blockchain status (added: review, the platform reports it)', () => {
  it('confirmed, with when', () => {
    assert.equal(
      statusSentence(
        {state: 'confirmed', label: 'confirmed', at: 'x'},
        '14 Nov 2026, 10:00',
      ),
      'The platform reports: confirmed on the blockchain on 14 Nov 2026, 10:00. The offline check confirms it independently.',
    );
  });

  it('confirmed, without a time', () => {
    assert.equal(
      statusSentence({state: 'confirmed', label: 'confirmed', at: null}, null),
      'The platform reports: confirmed on the blockchain. The offline check confirms it independently.',
    );
  });

  it('written, waiting for confirmation', () => {
    assert.equal(
      statusSentence(
        {
          state: 'recorded',
          label: 'written, waiting for confirmation',
          at: null,
        },
        null,
      ),
      'The platform reports: written to the blockchain, waiting for confirmation. The offline check confirms it independently once it is confirmed.',
    );
  });

  it('pending', () => {
    assert.equal(
      statusSentence({state: 'pending', label: 'pending', at: null}, null),
      'The platform reports: pending, not on the blockchain yet. The latest step goes there with the next recording; the offline check can confirm it after that.',
    );
  });
});

describe("the proof's keys against the keys this platform publishes (added: review)", () => {
  it('the same keys: they match, with their fingerprint', async () => {
    const key = await platformKey('bl-title:v1');
    const jwks = {keys: [key.jwk]};
    const check = await keyCheck(jwks, {keys: [{...key.jwk}]}, subtle);
    assert.deepEqual(check, {
      state: 'match',
      fingerprint: verifierFingerprint(jwks),
    });
    assert.equal(
      keyNote(check),
      `Signed with the keys this platform publishes (fingerprint ${verifierFingerprint(jwks)}). For an independent check, compare this fingerprint with one you received another way, for example from the carrier.`,
    );
  });

  it('other keys: they differ, a clear failure', async () => {
    const key = await platformKey('bl-title:v1');
    const other = await platformKey('bl-title:v1');
    const check = await keyCheck(
      {keys: [key.jwk]},
      {keys: [other.jwk]},
      subtle,
    );
    assert.equal(check.state, 'differ');
    assert.equal(
      keyNote(check),
      'The keys in this proof are not the keys this platform publishes: do not rely on this proof. Tell the carrier.',
    );
  });

  it('the published keys cannot be read, or no cryptography: unknown', async () => {
    const key = await platformKey('bl-title:v1');
    assert.deepEqual(await keyCheck({keys: [key.jwk]}, null, subtle), {
      state: 'unknown',
      fingerprint: null,
    });
    assert.deepEqual(
      await keyCheck({keys: [key.jwk]}, {keys: [key.jwk]}, null),
      {state: 'unknown', fingerprint: null},
    );
    assert.equal(
      keyNote({state: 'unknown', fingerprint: null}),
      'The keys this platform publishes cannot be compared here now: check the proof offline.',
    );
  });
});

describe('a B/L made by a split (added: second review)', () => {
  it("says the parent B/L's chain is checked only offline", () => {
    assert.equal(
      splitNote({entries: []}),
      "This B/L was made by splitting another B/L: that B/L's chain of title is not checked in this browser, only by the offline check.",
    );
  });

  it('says nothing for a B/L of its own', () => {
    assert.equal(splitNote(undefined), null);
  });
});
