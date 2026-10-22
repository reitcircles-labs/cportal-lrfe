import {printedCheckCode} from '../src/check-code.js';
import {X509Certificate, createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect} from 'chai';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createProofClient} from '../src/proof-client.js';
import {createBaoSealer, sealerFromEnv} from '../src/seal/sealers.js';
import {DEFAULT_LEGAL_TEXT, extractSettingsFromEnv} from '../src/settings.js';
import {actor} from '../../land-records/tests/helpers.js';
import {
  CHECK_URL_BASE,
  TX,
  committedErf1873,
  makeExtracts,
  sharedTestSealer,
  users,
} from './helpers.js';
import {
  allStreams,
  attachments,
  checkSignature,
  readPdf,
  readQr,
} from './pdf-reader.js';

const rec = actor(users.rec);

/** A PNG of one pixel: a stand-in for a registry's coat of arms. */
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The ID numbers of the three owners of Erf 1873 (land-records tests). */
const ID_NUMBERS = ['75060200418', '98030100562', '01112500379'];

const forMaria = record => ({
  recordId: record.id,
  versionNumber: 1,
  ownerIndex: 0,
  idNo: '75060200418',
  documentSeen: true,
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function rejects(promise, status, message) {
  try {
    await promise;
  } catch (err) {
    if (status) expect(err.statusCode).to.equal(status);
    if (message) expect(err.message).to.include(message);
    return err;
  }
  throw new Error('expected a rejection');
}

/** An extract issued for Maria Nghishidi on version 1 of Erf 1873, and its PDF. */
async function issued() {
  const context = await makeExtracts();
  const record = await committedErf1873(context.records);
  const extract = await context.service.issue(forMaria(record), rec);
  const {pdf} = await context.service.pdf(extract.id);
  return {...context, record, extract, pdf};
}

describe('the extract PDF (API-691)', () => {
  it('holds the registry, the extract, the record version, its owners and the check facts', async () => {
    const {record, extract, pdf} = await issued();
    const {text, pages} = await readPdf(pdf);
    expect(pages).to.have.length(1);
    for (const expected of [
      'Land Titles Office',
      'Republic of Testland',
      'Ownership extract',
      'EX-NA-2026-000001',
      // the check page's address and the check code, for typing in (API-692)
      CHECK_URL_BASE,
      printedCheckCode(extract.checkCode),
      'Issued 21 October 2026, 08:00',
      'The land record, version 1 (current on the issue date)',
      `Parcel ${record.label}`,
      `Land record ${record.recordNo} · version 1`,
      'Registration division K',
      'Extent 1 214 square metres',
      'Tenure Freehold',
      'Title deed T 4521/2019',
      'Registered owners',
      'Maria Nghishidi •••••••0418 ½',
      'Ndapewa Nghishidi •••••••0562 ¼',
      'Tomas Nghishidi •••••••0379 ¼',
      'Issued to Maria Nghishidi, registered owner, identity document seen at the counter.',
      'Check this extract against the blockchain',
      'No login is needed.',
      `Fingerprint ${record.current.seal}`,
      'Batch 7, on the blockchain since 21 Oct 2026, 07:00',
      `Transaction ${TX}`,
      'Always scan the QR code. Don’t rely on this paper alone.',
      'only the check page can tell you.',
      'Electronic seal This PDF carries the electronic seal of Land Titles Office, Republic of Testland and',
      'Legal wording of the test registry.',
      `attached: record-v1.proof.json`,
      'Page 1 of 1',
    ]) {
      expect(text).to.include(expected);
    }
    expect(text.replace(/\s+/g, '')).to.include(
      `https://preview.cexplorer.io/tx/${TX}`,
    );
    // the township is in the parcel's name, not a row of its own (design, API-690)
    expect(text).to.not.include('Township');
    // always "blockchain", never the network or the tools behind it
    expect(text.toLowerCase()).to.not.match(/cardano|ada\b|openbao|vault/);
  });

  it('never holds an owner’s full ID number, anywhere in the file', async () => {
    const {pdf} = await issued();
    const {pdfDoc, text} = await readPdf(pdf);
    const everything = [
      Buffer.from(pdf).toString('latin1'),
      allStreams(pdfDoc),
      text,
      ...Object.values(attachments(pdfDoc)).map(b => b.toString('utf8')),
    ].join('\n');
    for (const idNo of ID_NUMBERS) {
      expect(everything).to.not.include(idNo);
      // nor as the hex of a drawn text
      expect(everything.toLowerCase()).to.not.include(
        Buffer.from(idNo).toString('hex'),
      );
    }
  });

  it('carries a QR code that a reader decodes to the check page with the token', async () => {
    const {extract, pdf} = await issued();
    const {pages, text} = await readPdf(pdf);
    expect(readQr(pages[0])).to.equal(`${CHECK_URL_BASE}/${extract.token}`);
    // for typing in, the check page's address and the check code are printed; the token is not
    expect(text).to.include(CHECK_URL_BASE);
    expect(text).to.include(printedCheckCode(extract.checkCode));
    expect(text).not.to.include(extract.token);
  });

  it("has the version's proof attached inside, the same JSON as the evidence pack's", async () => {
    const {proofs, record, pdf} = await issued();
    const {pdfDoc} = await readPdf(pdf);
    const files = attachments(pdfDoc);
    expect(Object.keys(files)).to.deep.equal(['record-v1.proof.json']);
    const {proof} = await proofs.recordProof(record.id, 1);
    // the bytes audit's evidence pack writes as proofs/record-v1.json
    expect(files['record-v1.proof.json'].toString('utf8')).to.equal(
      `${JSON.stringify(proof, null, 2)}\n`,
    );
  });

  it('is sealed: a PAdES signature over the whole file, valid with the seal certificate', async () => {
    const {pdf} = await issued();
    const seal = await checkSignature(pdf);
    expect(seal).to.include({
      subFilter: 'ETSI.CAdES.detached',
      coversAllButSignature: true,
      digestMatches: true,
      signatureValid: true,
      pkijsValid: true,
    });
    const sealer = await sharedTestSealer();
    expect(seal.certificateDer.equals(await sealer.certificate())).to.equal(
      true,
    );
    // content type, message digest and the signing certificate (PAdES B-B)
    expect(seal.signedAttributeTypes.sort()).to.deep.equal([
      '1.2.840.113549.1.9.16.2.47',
      '1.2.840.113549.1.9.3',
      '1.2.840.113549.1.9.4',
    ]);
  });

  it('a single changed byte breaks the seal', async () => {
    const {pdf} = await issued();
    const text = Buffer.from(pdf).toString('latin1');
    // a byte of the page, then a byte of the end of the file, both inside the signed range
    for (const at of [text.indexOf('/MediaBox'), pdf.length - 10]) {
      const tampered = Buffer.from(pdf);
      tampered[at] ^= 0x01;
      const seal = await checkSignature(tampered);
      expect(seal.digestMatches, `byte ${at}`).to.equal(false);
      expect(seal.pkijsValid, `byte ${at}`).to.equal(false);
    }
  });

  it('is stored as issued: the register and the issued event have its SHA-256, and "download again" gives the same bytes', async () => {
    const {service, extract, pdf, published, app, as} = await issued();
    expect(extract.pdfSha256).to.equal(sha256(pdf));
    expect(extract).to.not.have.property('pdfKey');
    const [event] = published;
    expect(event.type).to.equal('extracts.extract.issued');
    expect(event.data.pdfSha256).to.equal(sha256(pdf));

    const again = await service.pdf(extract.id);
    expect(again.pdf.equals(pdf)).to.equal(true);

    const download = u =>
      app.inject({url: `/extracts/${extract.id}/pdf`, headers: as(u)});
    const res = await download(users.rec);
    expect(res.statusCode).to.equal(200);
    expect(res.headers['content-type']).to.equal('application/pdf');
    expect(res.headers['content-disposition']).to.equal(
      `attachment; filename="extract-${extract.recordNo}-v1.pdf"`,
    );
    expect(res.rawPayload.equals(pdf)).to.equal(true);
    expect((await download(users.sup)).statusCode).to.equal(403);
  });

  it('is not given out again once revoked, nor when the stored file was changed', async () => {
    const {service, files, extract} = await issued();
    const key = [...files.blobs.keys()][0];
    files.blobs.get(key).data[100] ^= 0x01;
    await rejects(service.pdf(extract.id), 500, 'does not match the register');
    await service.revoke(extract.id, {reason: 'Lost'}, rec);
    await rejects(service.pdf(extract.id), 409, 'The extract is revoked');
  });

  it('is refused before the version is on the blockchain, with no PDF made or kept', async () => {
    const {records, service, anchoring, proofs, files, published} =
      await makeExtracts();
    const record = await committedErf1873(records);
    anchoring.status[`record-version:${record.id}:1`] = {status: 'waiting'};
    await rejects(
      service.issue(forMaria(record), rec),
      409,
      `Version 1 of ${record.recordNo} is not on the blockchain yet: an extract can be issued once it is`,
    );
    // the proof says otherwise than the status asked a moment before
    delete anchoring.status[`record-version:${record.id}:1`];
    const {proof, explorerUrl} = await proofs.recordProof(record.id, 1);
    proofs.result[`${record.id}:1`] = {
      proof: {...proof, status: 'anchored'},
      explorerUrl,
    };
    await rejects(
      service.issue(forMaria(record), rec),
      409,
      `Version 1 of ${record.recordNo} is not on the blockchain yet`,
    );
    proofs.result[`${record.id}:1`] = {
      proof: {...proof, item: {...proof.item, seal: 'f'.repeat(64)}},
      explorerUrl,
    };
    await rejects(
      service.issue(forMaria(record), rec),
      409,
      'does not match the one on the blockchain',
    );
    delete proofs.result[`${record.id}:1`];
    proofs.down = true;
    await rejects(service.issue(forMaria(record), rec), 503);
    expect(files.blobs.size).to.equal(0);
    expect(published).to.deep.equal([]);
  });

  it('is refused while no seal is set up, with a message that names no setting', async () => {
    const {records, service, files} = await makeExtracts();
    const record = await committedErf1873(records);
    service.sealer = null;
    const err = await rejects(
      service.issue(forMaria(record), rec),
      503,
      'the registry’s electronic seal is not set up. Tell the administrator.',
    );
    expect(err.message).to.not.match(/EXTRACTS_|bao|vault/i);
    expect(files.blobs.size).to.equal(0);
  });

  it('keeps no PDF when the register row cannot be written', async () => {
    const {records, service, repo, files} = await makeExtracts();
    const record = await committedErf1873(records);
    repo.addExtract = async () => {
      throw new Error('database down');
    };
    await rejects(service.issue(forMaria(record), rec), null, 'database down');
    expect(files.blobs.size).to.equal(0);
  });

  it('prints names with Khoekhoe clicks and other letters the standard fonts lack as closely as they can', async () => {
    const {records, service} = await makeExtracts();
    const record = await committedErf1873(records);
    const names = {
      'Johannes ǃGawaseb': 'Johannes !Gawaseb',
      'Petrus ǀAwases': 'Petrus |Awases',
      'Anna ǁKhaba': 'Anna ||Khaba',
      'Josef ǂNûseb': 'Josef ‡Nûseb',
      'Łukasz Dvořák': 'Lukasz Dvorák',
      'Ṭhabo Ŋcube': 'Thabo Ncube',
    };
    record.current.data.owners = Object.keys(names).map((name, i) => ({
      name,
      idNo: `7506020041${i}`,
      share: '1/6',
      since: 'T 4521/2019',
    }));
    const pdf = await service.sealedPdf(
      {
        ...forMaria(record),
        id: 'e1',
        extractNo: 'EX-NA-2026-000001',
        checkCode: 'K7QF2M9DXH4T',
        recordNo: record.recordNo,
        token: 't'.repeat(43),
        issuedAt: new Date(),
        ownerName: 'Johannes ǃGawaseb',
      },
      record,
      (await service.proofs.recordProof(record.id, 1)).proof,
      null,
    );
    const {lines, text} = await readPdf(pdf);
    for (const printed of Object.values(names)) {
      expect(lines).to.include(printed);
    }
    expect(text).to.include('Issued to Johannes !Gawaseb, registered owner');
    // no "?" in place of a letter: only the check box's question
    expect(lines.filter(line => line.includes('?'))).to.deep.equal([
      'No camera? Open this address and type the check code:',
    ]);
  });

  it('runs onto a second page for many owners, the footer on each', async () => {
    const {records, service} = await makeExtracts();
    const record = await committedErf1873(records);
    const many = Array.from({length: 40}, (_, i) => ({
      name: `Owner ${i + 1} Nghishidi`,
      idNo: `750602${String(i).padStart(5, '0')}`,
      share: '1/40',
      since: 'T 4521/2019',
    }));
    record.current.data.owners = many;
    const pdf = await service.sealedPdf(
      {
        ...forMaria(record),
        id: 'e1',
        extractNo: 'EX-NA-2026-000001',
        checkCode: 'K7QF2M9DXH4T',
        recordNo: record.recordNo,
        token: 't'.repeat(43),
        issuedAt: new Date(),
        ownerName: 'Owner 1 Nghishidi',
      },
      record,
      (await service.proofs.recordProof(record.id, 1)).proof,
      null,
    );
    const {pages} = await readPdf(pdf);
    expect(pages.length).to.be.greaterThan(1);
    pages.forEach((page, i) =>
      expect(page.lines).to.include(`Page ${i + 1} of ${pages.length}`),
    );
    expect(pages.flatMap(p => p.lines)).to.include('Owner 40 Nghishidi');
  });
});

describe('the seal and the settings (API-691)', () => {
  it('without EXTRACTS_SEAL: a test seal outside production, none in production', async () => {
    expect((await sealerFromEnv({env: {NODE_ENV: 'test'}})).kind).to.equal(
      'test',
    );
    expect(await sealerFromEnv({env: {NODE_ENV: 'production'}})).to.equal(null);
    let error;
    try {
      await sealerFromEnv({env: {EXTRACTS_SEAL: 'yes'}});
    } catch (err) {
      error = err;
    }
    expect(error?.message).to.include('EXTRACTS_SEAL must be bao');
  });

  it('the vault seal needs its settings, and signs only with the key version of its certificate, prehashed', async () => {
    const testSealer = await sharedTestSealer();
    const pemOf = der =>
      `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
    const certificatePem = pemOf(await testSealer.certificate());
    expect(() =>
      createBaoSealer({addr: 'http://bao', keyName: 'extracts-seal'}),
    ).to.throw('BAO_ROLE_ID is required');

    const secretIdFile = join(tmpdir(), `extracts-seal-secret-${process.pid}`);
    await writeFile(secretIdFile, 'secret-id\n');
    // a stand-in for OpenBao: version 1 of its key is the test seal's (its public key from the
    // certificate); `vault.keys` and `vault.latest` change when it is rotated
    const certifiedKey = new X509Certificate(
      await testSealer.certificate(),
    ).publicKey.export({type: 'spki', format: 'pem'});
    const otherKey = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    }).publicKey.export({type: 'spki', format: 'pem'});
    const vault = {
      latest: 1,
      keys: {1: {public_key: certifiedKey}},
      calls: [],
      signed: [],
    };
    const fakeBao = async (url, init) => {
      const path = new URL(url).pathname;
      vault.calls.push(`${init.method} ${path}`);
      const body = init.body ? JSON.parse(init.body) : null;
      const answer = json => ({ok: true, status: 200, json: async () => json});
      if (path === '/v1/auth/approle/login') {
        return answer({auth: {client_token: 't1', lease_duration: 3600}});
      }
      if (path === '/v1/transit/keys/extracts-seal') {
        return answer({
          data: {
            type: 'ecdsa-p256',
            latest_version: vault.latest,
            keys: vault.keys,
          },
        });
      }
      if (path === '/v1/transit/sign/extracts-seal') {
        vault.signed.push(body);
        return answer({data: {signature: 'vault:v1:c2lnbmF0dXJl'}});
      }
      return {ok: false, status: 404, json: async () => ({errors: ['no']})};
    };
    const settings = {
      addr: 'http://bao:8200',
      roleId: 'role',
      secretIdFile,
      keyName: 'extracts-seal',
      fetch: fakeBao,
    };
    const sealer = createBaoSealer({...settings, certificatePem});
    const signature = await sealer.sign(Buffer.from('signed attributes'));
    expect(signature.toString()).to.equal('signature');
    // only the digest goes to the vault, never the document; signed with version 1
    expect(vault.signed).to.deep.equal([
      {
        input: createHash('sha256')
          .update('signed attributes')
          .digest('base64'),
        prehashed: true,
        hash_algorithm: 'sha2-256',
        key_version: 1,
        marshaling_algorithm: 'asn1',
      },
    ]);
    expect(vault.calls).to.deep.equal([
      'POST /v1/auth/approle/login',
      'GET /v1/transit/keys/extracts-seal',
      'POST /v1/transit/sign/extracts-seal',
    ]);

    // rotated: version 2 is another key; the certificate is still for version 1, so it signs with 1
    vault.keys = {...vault.keys, 2: {public_key: otherKey}};
    vault.latest = 2;
    await sealer.sign(Buffer.from('x'));
    expect(vault.signed.at(-1).key_version).to.equal(1);

    // version 1 no longer there: refused before anything is signed
    vault.keys = {2: {public_key: otherKey}};
    vault.latest = 3;
    const count = vault.signed.length;
    const rotated = await rejects(sealer.sign(Buffer.from('x')), 503);
    expect(rotated.cause.message).to.include(
      'The seal certificate is for no version of OpenBao key extracts-seal',
    );
    expect(vault.signed).to.have.length(count);

    // the certificate's key is version 4, the newest, after another rotation
    vault.keys = {...vault.keys, 4: {public_key: certifiedKey}};
    vault.latest = 4;
    await sealer.sign(Buffer.from('x'));
    expect(vault.signed.at(-1).key_version).to.equal(4);

    // a certificate for another key: refused, with a message for staff that names no tool
    const other = createBaoSealer({
      ...settings,
      certificatePem: pemOf(
        await (await sealerFromEnv({env: {}})).certificate(),
      ),
    });
    const err = await rejects(other.sign(Buffer.from('x')), 503);
    expect(err.message).to.not.match(/bao|vault/i);
    expect(err.cause.message).to.include('for no version of OpenBao key');
    expect(vault.signed).to.have.length(count + 1);
  });

  it('the site settings: the organisation, the check page, the legal wording, the time zone', () => {
    const settings = extractSettingsFromEnv({
      LRFE_ORG_NAME: 'Land Titles Office',
      EXTRACTS_CHECK_URL_BASE: 'https://titles.example/#/check',
    });
    expect(settings.org.name).to.equal('Land Titles Office');
    expect(settings.checkUrlBase).to.equal('https://titles.example/#/check');
    expect(settings.legalText).to.equal(DEFAULT_LEGAL_TEXT);
    // not set: the portal's own address
    expect(
      extractSettingsFromEnv({
        NODE_ENV: 'production',
        LRFE_PUBLIC_URL: 'https://deeds.example.gov/',
      }).checkUrlBase,
    ).to.equal('https://deeds.example.gov/#/check');
    expect(() => extractSettingsFromEnv({NODE_ENV: 'production'})).to.throw(
      'EXTRACTS_CHECK_URL_BASE or LRFE_PUBLIC_URL is required',
    );
    expect(() =>
      extractSettingsFromEnv({EXTRACTS_TIME_ZONE: 'Nowhere/Town'}),
    ).to.throw(RangeError);
    expect(settings.coatOfArms).to.equal(null);
  });

  it('prints the coat of arms beside the registry name when the site has one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arms-'));
    try {
      const file = join(dir, 'arms.png');
      await writeFile(file, Buffer.from(ONE_PIXEL_PNG, 'base64'));
      const {coatOfArms} = extractSettingsFromEnv({
        EXTRACTS_COAT_OF_ARMS_FILE: file,
      });
      expect(coatOfArms.type).to.equal('png');
      const imagesOn = async pdf => {
        const page = (await PDFDocument.load(pdf)).getPages()[0];
        const xObjects = page.node.Resources().lookup(PDFName.of('XObject'));
        return xObjects ? xObjects.keys().length : 0;
      };

      const without = await issued();
      expect(await imagesOn(without.pdf)).to.equal(0);
      const context = await makeExtracts();
      context.service.settings = {...context.service.settings, coatOfArms};
      const record = await committedErf1873(context.records);
      const extract = await context.service.issue(forMaria(record), rec);
      const {pdf} = await context.service.pdf(extract.id);
      expect(await imagesOn(pdf)).to.equal(1);
      expect((await readPdf(pdf)).text).to.include('Land Titles Office');
      expect(await checkSignature(pdf)).to.include({
        digestMatches: true,
        signatureValid: true,
      });

      // another kind of file, or none: the service does not start
      const text = join(dir, 'arms.txt');
      await writeFile(text, 'not an image');
      expect(() =>
        extractSettingsFromEnv({EXTRACTS_COAT_OF_ARMS_FILE: text}),
      ).to.throw('must be a PNG or JPEG image');
      expect(() =>
        extractSettingsFromEnv({EXTRACTS_COAT_OF_ARMS_FILE: `${text}.gone`}),
      ).to.throw('ENOENT');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe('the audit service proof client (API-691)', () => {
  const client = fetchImpl =>
    createProofClient({
      baseUrl: 'http://audit',
      serviceToken: () => 'service-token',
      fetchImpl,
    });

  it('asks POST /audit/anchoring/proof with the service token', async () => {
    const answer = {proof: {status: 'confirmed'}, explorerUrl: null};
    let asked;
    const got = await client(async (url, init) => {
      asked = {url, init};
      return {ok: true, status: 200, json: async () => answer};
    }).recordProof('r1', 2);
    expect(got).to.deep.equal(answer);
    expect(asked.url).to.equal('http://audit/audit/anchoring/proof');
    expect(asked.init.method).to.equal('POST');
    expect(asked.init.headers.authorization).to.equal('Bearer service-token');
    expect(JSON.parse(asked.init.body)).to.deep.equal({
      recordId: 'r1',
      version: 2,
    });
  });

  it('is a 503 when the audit service cannot answer: the extract is then not issued', async () => {
    for (const fetchImpl of [
      async () => ({
        ok: false,
        status: 404,
        json: async () => ({message: 'not in the tree'}),
      }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ]) {
      const err = await rejects(client(fetchImpl).recordProof('r1', 1), 503);
      expect(err.message).to.include('cannot be read now');
    }
  });
});
