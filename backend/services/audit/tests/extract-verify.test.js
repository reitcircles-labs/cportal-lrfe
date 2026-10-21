import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import {
  checkPdfSeal,
  extractVerdict,
  pdfAttachments,
  verifyExtract,
} from '../verifier/lrfe-verify.mjs';
import {TreeService} from '../src/tree.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {createLocalSigner} from '../src/cardano/signer.js';
import {addressOf, anchorMetadata, buildAnchorTx} from '../src/cardano/tx.js';
import {renderExtract} from '../../extracts/src/pdf/extract-pdf.js';
import {sealPdf} from '../../extracts/src/seal/seal-pdf.js';
import {createTestSealer} from '../../extracts/src/seal/sealers.js';
import {extractSettingsFromEnv} from '../../extracts/src/settings.js';
import {PARAMS} from './helpers.js';
import {audited, publicSource, quiet} from './register.js';

const VERIFIER = fileURLToPath(
  new URL('../verifier/lrfe-verify.mjs', import.meta.url),
);
const clone = x => structuredClone(x);
const failed = r => r.checks.filter(c => !c.ok).map(c => c.name);

/** The time of each block on the fake chain, as Koios gives it (tx_timestamp, seconds). */
const BLOCK_TIME = Date.parse('2026-10-11T09:05:00Z') / 1000;

/** Koios answering from the fake chain, with each transaction's time. */
function koios(driver) {
  const source = publicSource(driver);
  return async (url, init) => {
    const res = await source(url, init);
    if (!url.endsWith('/tx_info')) return res;
    const rows = await res.json();
    return {
      ...res,
      json: async () => rows.map(r => ({...r, tx_timestamp: BLOCK_TIME})),
    };
  };
}

let sealer = null;

/**
 * An ownership extract of the record's version 1 as the extracts service makes it (its PDF builder
 * and seal, with the test seal), the given proof attached.
 */
async function extractPdf(a, proof) {
  sealer ??= await createTestSealer({name: 'Land Titles Office'});
  const issuedAt = new Date('2026-10-11T10:00:00Z');
  const pdfDoc = await renderExtract({
    extract: {
      id: '7d3f0c2e-1b8a-4c55-9e61-2a4b8c9d0e1f',
      token: 'test-token',
      issuedAt,
      versionNumber: 1,
      ownerName: a.record.current.data.owners[0].name,
    },
    record: a.record,
    proof,
    explorerUrl: `https://explorer.example/tx/${proof.anchor?.tx}`,
    settings: extractSettingsFromEnv({
      LRFE_ORG_NAME: 'Land Titles Office',
      EXTRACTS_CHECK_URL_BASE: 'https://registry.example/check',
      EXTRACTS_TIME_ZONE: 'UTC',
    }),
  });
  return sealPdf(pdfDoc, sealer, {
    name: 'Land Titles Office',
    reason: `Ownership extract of ${a.record.recordNo}, version 1`,
    signingTime: issuedAt,
  });
}

/** The proof of the record's version 1, as the evidence pack and the extract hold it (JSON). */
const proofOf = async (a, kind = 'record-version', id = a.record.id) =>
  JSON.parse(JSON.stringify(await a.proofs.proof(kind, id, 1)));

/** Erf 1873 committed and anchored, its wallet and its extract. */
async function anchoredExtract() {
  const a = await audited();
  await a.anchor();
  const proof = await proofOf(a);
  const wallet = await a.cardano.address();
  return {a, proof, wallet, pdf: await extractPdf(a, proof)};
}

/** The command line on a PDF, without a network: only for results reached before the blockchain. */
function cli(pdf) {
  const dir = mkdtempSync(join(tmpdir(), 'lrfe-extract-'));
  try {
    writeFileSync(join(dir, 'extract.pdf'), pdf);
    return spawnSync(process.execPath, [VERIFIER, join(dir, 'extract.pdf')], {
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

describe('checking an ownership extract offline (API-694)', () => {
  it('a valid extract: its attached proof is on the blockchain, sent from the published address, and the registry seal holds', async () => {
    const {a, proof, wallet, pdf} = await anchoredExtract();
    // the attachment as the verifier reads it, without a PDF library, is the proof byte for byte
    assert.equal(
      pdfAttachments(pdf).get('record-v1.proof.json').toString('utf8'),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
    const r = await verifyExtract(pdf, {
      address: wallet,
      fetchImpl: koios(a.driver),
    });
    assert.equal(r.valid, true, JSON.stringify(r.checks));
    assert.deepEqual(
      r.checks.map(c => c.name),
      [
        'attached proof',
        'item',
        'leaf',
        'path to the root',
        'transaction on chain',
        'root in the transaction',
        'paid by the anchoring wallet',
        'batch',
        'registry seal',
      ],
    );
    assert.equal(r.batch, proof.anchor.batch);
    assert.equal(r.date, new Date(BLOCK_TIME * 1000).toISOString());
    assert.equal(
      r.seal.subject,
      'CN=Land Titles Office (test seal, not valid)',
    );
    assert.equal(
      extractVerdict(r),
      `VALID: version 1 of the land record is on the blockchain, in batch ${proof.anchor.batch} of 2026-10-11, sent from the registry's address, and the PDF is as the registry sealed it.`,
    );
    assert.ok(r.notes[0].includes('newer version'));
    assert.ok(r.notes[0].includes('scan the QR code'));
    // "blockchain", never the network's name, in what the extract mode itself says
    const said = [extractVerdict(r), ...r.notes, r.seal.detail].join(' ');
    assert.doesNotMatch(said, /cardano/i);
  });

  it('a changed field in the attached proof fails, even when the PDF is sealed again', async () => {
    const {a, proof, wallet} = await anchoredExtract();
    const changes = {
      'the fingerprint': p => {
        p.item.seal = 'ee'.repeat(32);
        p.leaf.item = 'ee'.repeat(32);
      },
      'the leaf position': p => {
        p.leaf.index += 1;
      },
      'the root': p => {
        p.tree.root = 'ab'.repeat(32);
      },
      'the batch': p => {
        p.anchor.batch += 1;
      },
    };
    const expected = {
      'the fingerprint': ['leaf', 'path to the root'],
      'the leaf position': ['path to the root'],
      'the root': ['path to the root', 'root in the transaction'],
      'the batch': ['batch'],
    };
    for (const [what, change] of Object.entries(changes)) {
      const changed = clone(proof);
      change(changed);
      const r = await verifyExtract(await extractPdf(a, changed), {
        address: wallet,
        fetchImpl: koios(a.driver),
      });
      assert.equal(r.valid, false, what);
      assert.deepEqual(failed(r), expected[what], what);
      assert.match(extractVerdict(r), /^NOT VALID: /, what);
    }
  });

  it('a wrong proof attached fails: another item’s, or another version’s', async () => {
    const {a, wallet} = await anchoredExtract();
    const documentProof = await proofOf(a, 'document-version', a.docs.t2019.id);
    const r = await verifyExtract(await extractPdf(a, documentProof), {
      address: wallet,
      fetchImpl: koios(a.driver),
    });
    assert.deepEqual(
      [r.valid, failed(r), r.checks[0].detail],
      [
        false,
        ['attached proof'],
        'record-v1.proof.json is not the proof of a land record version (document-version)',
      ],
    );
    const otherVersion = await proofOf(a);
    otherVersion.item.version = 2;
    const second = await verifyExtract(await extractPdf(a, otherVersion), {
      address: wallet,
      fetchImpl: koios(a.driver),
    });
    assert.equal(
      second.checks[0].detail,
      'record-v1.proof.json is the proof of version 2',
    );
  });

  it('a transaction sent from another address fails against the published address', async () => {
    const {a, proof, wallet} = await anchoredExtract();
    // a forger's own tree holding the version's real fingerprint, its root sent from their wallet
    const forger = createLocalSigner();
    const forgerAddress = addressOf(await forger.publicKey(), 'preview');
    const tree = new TreeService({repo: createMemoryRepo(), logger: quiet});
    await tree.append([
      {key: proof.leaf.key, type: 1, item: proof.item.seal},
      {key: 'document-version:x:1', type: 2, item: 'ab'.repeat(32)},
    ]);
    const p = await tree.inclusionProof(proof.leaf.key);
    const utxo = a.driver.chain.topUp();
    const tx = buildAnchorTx({
      utxos: [utxo],
      address: forgerAddress,
      publicKey: await forger.publicKey(),
      params: PARAMS,
      metadata: anchorMetadata({
        root: p.root,
        size: p.size,
        batch: proof.anchor.batch,
      }),
      ttl: a.driver.chain.slot + 3600,
      input: {txHash: utxo.txHash, index: utxo.index},
    });
    const txHash = await a.driver.submit(
      tx.sign(await forger.sign(tx.bodyHash)).cbor,
    );
    const forged = {
      ...clone(proof),
      leaf: {...proof.leaf, index: p.leaf.index, hash: p.leaf.hash},
      tree: {size: p.size, path: p.path, peaks: p.peaks, root: p.root},
      anchor: {
        ...proof.anchor,
        tx: txHash,
        root: p.root,
        size: p.size,
        address: forgerAddress,
      },
    };
    const pdf = await extractPdf(a, forged);
    const r = await verifyExtract(pdf, {
      address: wallet,
      fetchImpl: koios(a.driver),
    });
    assert.deepEqual(failed(r), ['paid by the anchoring wallet']);
    assert.equal(
      r.checks.find(c => !c.ok).detail,
      `the proof's wallet ${forgerAddress} is not the given address ${wallet}`,
    );
    // the proof naming the wallet that really paid: passes only without the published address
    const unpinned = await verifyExtract(pdf, {fetchImpl: koios(a.driver)});
    assert.equal(unpinned.valid, true);
    assert.ok(unpinned.notes.some(n => n.includes(forgerAddress)));
  });

  it('a PDF without an attached proof is not valid, and says why (also on the command line, exit code 1)', async () => {
    sealer ??= await createTestSealer({name: 'Land Titles Office'});
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage().drawText('Ownership extract');
    const pdf = await sealPdf(pdfDoc, sealer, {
      name: 'Land Titles Office',
      reason: 'Ownership extract',
      signingTime: new Date('2026-10-11T10:00:00Z'),
    });
    const r = await verifyExtract(pdf, {
      fetchImpl: () => assert.fail('no blockchain call without a proof'),
    });
    assert.deepEqual([r.valid, failed(r)], [false, ['attached proof']]);
    const run = cli(pdf);
    assert.equal(run.status, 1, run.stderr);
    assert.match(
      run.stdout,
      /FAIL {2}attached proof: the PDF has no proof attached/,
    );
    assert.match(run.stdout, /newer version/);
    assert.match(run.stdout, /\nNOT VALID: attached proof: /);
    // a file that is not a PDF cannot be checked at all: exit code 2
    const notPdf = cli(Buffer.from('not a pdf'));
    assert.equal(notPdf.status, 2);
    assert.match(notPdf.stderr, /^Cannot read the extract /);
  });

  it('a PDF changed after it was sealed fails on its seal, and says the blockchain checks passed', async () => {
    const {a, wallet, pdf} = await anchoredExtract();
    assert.equal(checkPdfSeal(pdf).status, 'valid');
    // one character of the signature's reason changed: inside what the seal covers
    const text = pdf.toString('latin1');
    const at = text.indexOf('Ownership extract of');
    assert.ok(at > 0);
    const changed = Buffer.from(pdf);
    changed[at] = 'o'.charCodeAt(0);
    const r = await verifyExtract(changed, {
      address: wallet,
      fetchImpl: koios(a.driver),
    });
    assert.deepEqual(failed(r), ['registry seal']);
    assert.match(
      extractVerdict(r),
      /^NOT VALID: registry seal: the seal does not match the file: the PDF was changed after it was sealed\. The checks against the blockchain passed/,
    );
    // bytes added after the seal (an incremental update) are not covered
    const appended = Buffer.concat([pdf, Buffer.from('\n% added\n')]);
    assert.equal(checkPdfSeal(appended).status, 'invalid');
    // no seal at all
    const plain = await PDFDocument.create();
    plain.addPage();
    assert.equal(checkPdfSeal(Buffer.from(await plain.save())).status, 'none');
  });
});
