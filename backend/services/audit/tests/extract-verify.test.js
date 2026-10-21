import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
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

let registrySealer = null;

/** The registry's seal (a test seal) and its certificate's fingerprint, as GET /public/extracts/seal publishes it. */
async function registrySeal() {
  registrySealer ??= await createTestSealer({name: 'Land Titles Office'});
  const der = Buffer.from(await registrySealer.certificate());
  return {
    sealer: registrySealer,
    fingerprint: createHash('sha256').update(der).digest('hex'),
  };
}

/**
 * An ownership extract of the record's version 1 as the extracts service makes it (its PDF builder
 * and seal, by default the registry's test seal), the given proof attached; `ownerName` changes
 * the owner printed.
 */
async function extractPdf(a, proof, {sealer, ownerName} = {}) {
  sealer ??= (await registrySeal()).sealer;
  const record = clone(a.record);
  if (ownerName) record.current.data.owners[0].name = ownerName;
  const issuedAt = new Date('2026-10-11T10:00:00Z');
  const pdfDoc = await renderExtract({
    extract: {
      id: '7d3f0c2e-1b8a-4c55-9e61-2a4b8c9d0e1f',
      token: 'test-token',
      issuedAt,
      versionNumber: 1,
      ownerName: record.current.data.owners[0].name,
    },
    record,
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

/**
 * Erf 1873 committed and anchored, its extract, and `pinned`: the options that check it against
 * the registry's published address and seal fingerprint, on the fake chain.
 */
async function anchoredExtract() {
  const a = await audited();
  await a.anchor();
  const proof = await proofOf(a);
  const wallet = await a.cardano.address();
  const {fingerprint} = await registrySeal();
  const pinned = {
    address: wallet,
    seal: fingerprint,
    fetchImpl: koios(a.driver),
  };
  return {
    a,
    proof,
    wallet,
    fingerprint,
    pinned,
    pdf: await extractPdf(a, proof),
  };
}

/** The command line on a PDF, without a network: only for results reached before the blockchain. */
function cli(
  pdf,
  args = ['--address', 'addr_test1x', '--seal', 'ab'.repeat(32)],
) {
  const dir = mkdtempSync(join(tmpdir(), 'lrfe-extract-'));
  try {
    writeFileSync(join(dir, 'extract.pdf'), pdf);
    return spawnSync(
      process.execPath,
      [VERIFIER, join(dir, 'extract.pdf'), ...args],
      {encoding: 'utf8'},
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

/**
 * The review's shadow forgery (poc2): a genuine sealed extract whose signature space is widened to
 * hide a cross-reference table, catalog and attachments after the signature's hex, with a second
 * /ByteRange (in a comment) that describes the widened space. A reader that stopped at the end of
 * the hex would find the hidden catalog.
 */
function shadowed(genuine, proofJson) {
  const text = genuine.toString('latin1');
  const [, coveredEnd, gapEnd, restLength] = [
    ...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g),
  ]
    .at(-1)
    .slice(1)
    .map(Number);
  const startxref = Number([...text.matchAll(/startxref\s+(\d+)/g)].at(-1)[1]);
  assert.ok(startxref > gapEnd);
  const before = text.slice(0, coveredEnd);
  const signatureHex = text.slice(coveredEnd, gapEnd);
  const after = text.slice(gapEnd);
  const objects = {
    9001: '<< /Type /Catalog /Pages 9002 0 R /Names << /EmbeddedFiles 9004 0 R >> >>',
    9002: '<< /Type /Pages /Kids [9003 0 R] /Count 1 >>',
    9003: '<< /Type /Page /Parent 9002 0 R /MediaBox [0 0 595 842] >>',
    9004: '<< /Names [(record-v1.proof.json) 9005 0 R] >>',
    9005: '<< /Type /Filespec /F (record-v1.proof.json) /EF << /F 9006 0 R >> >>',
  };
  const streams = {9006: proofJson};
  const numbers = [9001, 9002, 9003, 9004, 9005, 9006];
  let hidden = '\n%shadow\n';
  const hiddenAt = coveredEnd + signatureHex.length;
  // the hidden table sits where the genuine startxref points
  hidden += ' '.repeat(startxref - (hiddenAt + hidden.length));
  const tableLength =
    `xref\n9001 ${numbers.length}\n`.length + 20 * numbers.length;
  const trailer = `trailer\n<< /Size 9007 /Root 9001 0 R >>\n`;
  const offsets = {};
  let body = '';
  const bodyAt = startxref + tableLength + trailer.length;
  for (const n of numbers) {
    offsets[n] = bodyAt + body.length;
    body +=
      streams[n] === undefined
        ? `${n} 0 obj\n${objects[n]}\nendobj\n`
        : `${n} 0 obj\n<< /Length ${streams[n].length} >>\nstream\n${streams[n]}\nendstream\nendobj\n`;
  }
  hidden +=
    `xref\n9001 ${numbers.length}\n` +
    numbers
      .map(n => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
      .join('') +
    trailer +
    body;
  const base = before.length + signatureHex.length + hidden.length;
  let widenedEnd = base + 60;
  let fake = '';
  for (let i = 0; i < 4; i++) {
    fake = `%/ByteRange [0 ${coveredEnd} ${widenedEnd} ${restLength}]\n`;
    widenedEnd = base + fake.length;
  }
  return Buffer.from(before + signatureHex + hidden + fake + after, 'latin1');
}

describe('checking an ownership extract offline (API-694)', () => {
  it('a valid extract: its attached proof is on the blockchain, sent from the published address, and the registry seal holds', async () => {
    const {a, proof, fingerprint, pinned, pdf} = await anchoredExtract();
    // the attachment as the verifier reads it, without a PDF library, is the proof byte for byte
    assert.equal(
      pdfAttachments(pdf).get('record-v1.proof.json').toString('utf8'),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
    const r = await verifyExtract(pdf, pinned);
    assert.equal(r.valid, true, JSON.stringify(r.checks));
    assert.deepEqual(
      r.checks.map(c => c.name),
      [
        'attached proof',
        'fingerprint',
        'leaf',
        'in the batch',
        'transaction on the blockchain',
        'batch fingerprint in the transaction',
        "sent from the registry's address",
        'batch',
        'registry seal',
      ],
    );
    assert.equal(r.seal.sha256, fingerprint);
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
    // "blockchain", never the network's or the public source's name, in everything it says
    const said = [
      extractVerdict(r),
      ...r.notes,
      ...r.checks.map(c => `${c.name} ${c.detail}`),
    ].join(' ');
    assert.doesNotMatch(said, /cardano|koios|blockfrost|preview|mainnet/i);
    // a public source that gives no time: the date is the proof's, and says so
    const undated = await verifyExtract(pdf, {
      ...pinned,
      fetchImpl: publicSource(a.driver),
    });
    assert.equal(undated.date, proof.anchor.confirmedAt);
    assert.match(
      extractVerdict(undated),
      / \(the date as the attached proof gives it\), sent from/,
    );
  });

  it('a changed field in the attached proof fails, even when the PDF is sealed again', async () => {
    const {a, proof, pinned} = await anchoredExtract();
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
      'the fingerprint': ['leaf', 'in the batch'],
      'the leaf position': ['in the batch'],
      'the root': ['in the batch', 'batch fingerprint in the transaction'],
      'the batch': ['batch'],
    };
    for (const [what, change] of Object.entries(changes)) {
      const changed = clone(proof);
      change(changed);
      const r = await verifyExtract(await extractPdf(a, changed), pinned);
      assert.equal(r.valid, false, what);
      assert.deepEqual(failed(r), expected[what], what);
      assert.match(extractVerdict(r), /^NOT VALID: /, what);
    }
  });

  it('a wrong proof attached fails: another item’s, or another version’s', async () => {
    const {a, pinned} = await anchoredExtract();
    const documentProof = await proofOf(a, 'document-version', a.docs.t2019.id);
    const r = await verifyExtract(await extractPdf(a, documentProof), pinned);
    assert.deepEqual(
      [r.valid, failed(r), r.checks[0].detail],
      [
        false,
        ['attached proof'],
        'record-v1.proof.json is not the proof of a land record version',
      ],
    );
    const otherVersion = await proofOf(a);
    otherVersion.item.version = 2;
    const second = await verifyExtract(
      await extractPdf(a, otherVersion),
      pinned,
    );
    assert.equal(
      second.checks[0].detail,
      'record-v1.proof.json is the proof of version 2',
    );
  });

  it('a transaction sent from another address fails against the published address', async () => {
    const {a, proof, wallet, pinned} = await anchoredExtract();
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
    const r = await verifyExtract(await extractPdf(a, forged), pinned);
    assert.deepEqual(failed(r), ["sent from the registry's address"]);
    assert.equal(
      r.checks.find(c => !c.ok).detail,
      `the proof's wallet ${forgerAddress} is not the given address ${wallet}`,
    );
    // never checked without the published address and seal fingerprint
    for (const missing of ['address', 'seal']) {
      const {[missing]: _, ...rest} = pinned;
      await assert.rejects(
        verifyExtract(await extractPdf(a, forged), rest),
        /published address and seal fingerprint: both are needed/,
      );
    }
  });

  it('a PDF without an attached proof is not valid, and says why (also on the command line, exit code 1)', async () => {
    const {sealer, fingerprint} = await registrySeal();
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage().drawText('Ownership extract');
    const pdf = await sealPdf(pdfDoc, sealer, {
      name: 'Land Titles Office',
      reason: 'Ownership extract',
      signingTime: new Date('2026-10-11T10:00:00Z'),
    });
    const r = await verifyExtract(pdf, {
      address: 'addr_test1x',
      seal: fingerprint,
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
    // without the registry's address and seal fingerprint, nothing is checked: exit code 2
    for (const args of [
      [],
      ['--address', 'addr_test1x'],
      ['--seal', fingerprint],
    ]) {
      const run2 = cli(pdf, args);
      assert.equal(run2.status, 2, args.join(' '));
      assert.equal(run2.stdout, '');
      assert.match(
        run2.stderr,
        /^usage: node lrfe-verify\.mjs extract\.pdf --address <the registry's address> --seal <the registry's seal fingerprint>/,
      );
    }
  });

  it('a PDF changed after it was sealed fails on its seal, and says the blockchain checks passed', async () => {
    const {pinned, pdf} = await anchoredExtract();
    assert.equal(checkPdfSeal(pdf).status, 'valid');
    // one character of the signature's reason changed: inside what the seal covers
    const text = pdf.toString('latin1');
    const at = text.indexOf('Ownership extract of');
    assert.ok(at > 0);
    const changed = Buffer.from(pdf);
    changed[at] = 'o'.charCodeAt(0);
    const r = await verifyExtract(changed, pinned);
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
    assert.equal(
      checkPdfSeal(Buffer.from(await plain.save({useObjectStreams: false})))
        .status,
      'none',
    );
  });

  it('a forged extract sealed with a self-made certificate of the same name is not valid (forgery A)', async () => {
    const {a, proof, pinned, fingerprint} = await anchoredExtract();
    // another owner printed, the genuine proof attached, sealed with the forger's own certificate
    const forger = await createTestSealer({name: 'Land Titles Office'});
    const forged = await extractPdf(a, proof, {
      sealer: forger,
      ownerName: 'Someone Else',
    });
    const seal = checkPdfSeal(forged, {fingerprint});
    // the seal itself holds and names the registry: only the fingerprint tells them apart
    assert.equal(checkPdfSeal(forged).status, 'valid');
    assert.equal(seal.subject, 'CN=Land Titles Office (test seal, not valid)');
    assert.equal(seal.status, 'invalid');
    const r = await verifyExtract(forged, pinned);
    assert.deepEqual([r.valid, failed(r)], [false, ['registry seal']]);
    assert.match(
      extractVerdict(r),
      new RegExp(
        `^NOT VALID: registry seal: the seal was not made with the registry's certificate: its certificate \\(CN=Land Titles Office \\(test seal, not valid\\)\\) has the fingerprint ${seal.sha256}, not the registry's ${fingerprint}\\.`,
      ),
    );
    // the fingerprint as copied from elsewhere: colons and capitals are fine
    const typed = fingerprint.toUpperCase().match(/../g).join(':');
    assert.equal(
      (
        await verifyExtract(await extractPdf(a, proof), {
          ...pinned,
          seal: typed,
        })
      ).valid,
      true,
    );
  });

  it('a seal this checker cannot verify never vouches for the PDF: changed bytes behind a patched algorithm are not valid (forgery B)', async () => {
    const {pinned, pdf} = await anchoredExtract();
    const changed = Buffer.from(pdf);
    const text = changed.toString('latin1');
    changed[text.indexOf('Ownership extract')] = 'o'.charCodeAt(0);
    // ecdsa-with-SHA256 in /Contents (outside what the seal covers) turned into an unknown algorithm
    const at = text.toLowerCase().lastIndexOf('06082a8648ce3d040302');
    assert.ok(at > 0);
    changed.write('06082a8648ce3d040309', at, 'latin1');
    const seal = checkPdfSeal(changed, {fingerprint: pinned.seal});
    assert.equal(seal.status, 'unchecked');
    assert.match(
      seal.detail,
      /cannot verify .* so it does not vouch for the PDF/,
    );
    const r = await verifyExtract(changed, pinned);
    assert.deepEqual([r.valid, failed(r)], [false, ['registry seal']]);
    assert.match(extractVerdict(r), /^NOT VALID: registry seal: /);
    assert.doesNotMatch(extractVerdict(r), /as the registry sealed it/);
  });

  it('a malformed attachment list ends at once, and attachments are capped in total size', async () => {
    // a name tree whose /Kids point back at itself, eight times at each level
    const objects = {
      1: '<< /Type /Catalog /Names 2 0 R >>',
      2: '<< /EmbeddedFiles 3 0 R >>',
      3: `<< /Kids [${'3 0 R '.repeat(8)}] >>`,
    };
    let text = '%PDF-1.7\n';
    const offsets = {};
    for (const [n, body] of Object.entries(objects)) {
      offsets[n] = text.length;
      text += `${n} 0 obj\n${body}\nendobj\n`;
    }
    const xref = text.length;
    text += 'xref\n0 4\n0000000000 65535 f \n';
    for (const n of [1, 2, 3]) {
      text += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }
    text += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const looped = Buffer.from(text, 'latin1');
    const started = Date.now();
    assert.equal(pdfAttachments(looped).size, 0);
    assert.ok(Date.now() - started < 1000);
    const {pinned} = await anchoredExtract();
    const r = await verifyExtract(looped, {
      ...pinned,
      fetchImpl: () => assert.fail('no blockchain call without a proof'),
    });
    assert.deepEqual(failed(r), ['attached proof']);
    // two attachments of 6 MB each: together more than any extract holds
    const big = await PDFDocument.create();
    big.addPage();
    for (const name of ['a.bin', 'b.bin']) {
      await big.attach(Buffer.alloc(6 * 1024 * 1024), name, {
        mimeType: 'application/octet-stream',
      });
    }
    const bigPdf = Buffer.from(await big.save({useObjectStreams: false}));
    assert.throws(
      () => pdfAttachments(bigPdf),
      /the attached files are larger than any extract holds/,
    );
    const run = cli(bigPdf);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /larger than any extract holds/);
  });

  it('a genuine extract with a shadow catalog hidden next to its signature is not valid (the review’s shadow forgery)', async () => {
    const {proof, pinned, pdf} = await anchoredExtract();
    const forged = shadowed(pdf, `${JSON.stringify(proof, null, 2)}\n`);
    const seal = checkPdfSeal(forged, {fingerprint: pinned.seal});
    assert.equal(seal.status, 'invalid');
    const r = await verifyExtract(forged, pinned);
    assert.equal(r.valid, false);
    // the hidden catalog is read, but the seal is not the registry's genuine one any more
    assert.deepEqual(failed(r), ['registry seal']);
    assert.match(
      seal.detail,
      /^the PDF has more than one seal, or a seal outside its signature field/,
    );
    assert.doesNotMatch(extractVerdict(r), /as the registry sealed it/);
    // anything but one hex string in the space the seal leaves out fails, a single space too
    const text = pdf.toString('latin1');
    const [, coveredEnd] = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)/
      .exec(text)
      .slice(1)
      .map(Number);
    const spaced = Buffer.from(pdf);
    spaced[coveredEnd + 1] = ' '.charCodeAt(0);
    assert.match(
      checkPdfSeal(spaced, {fingerprint: pinned.seal}).detail,
      /^the space left for the seal holds more than the seal/,
    );
  });

  it('a proof attached twice is not valid, with exit code 1', async () => {
    const {proof} = await anchoredExtract();
    const {sealer, fingerprint} = await registrySeal();
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage();
    for (let i = 0; i < 2; i++) {
      await pdfDoc.attach(
        Buffer.from(`${JSON.stringify(proof, null, 2)}\n`),
        'record-v1.proof.json',
        {mimeType: 'application/json'},
      );
    }
    const pdf = await sealPdf(pdfDoc, sealer, {
      name: 'Land Titles Office',
      reason: 'Ownership extract',
      signingTime: new Date('2026-10-11T10:00:00Z'),
    });
    const r = await verifyExtract(pdf, {
      address: 'addr_test1x',
      seal: fingerprint,
      fetchImpl: () => assert.fail('no blockchain call'),
    });
    assert.deepEqual(
      [r.valid, failed(r), r.checks[0].detail],
      [
        false,
        ['attached proof'],
        'record-v1.proof.json is attached twice: it is not an extract as the registry issued it',
      ],
    );
    const run = cli(pdf);
    assert.equal(run.status, 1, run.stderr);
    assert.match(
      run.stdout,
      /\nNOT VALID: attached proof: record-v1\.proof\.json is attached twice/,
    );
  });
});
