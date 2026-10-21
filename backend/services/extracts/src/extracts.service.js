import {
  X509Certificate,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@lrfe/common';
import {checkOnChain, checkOwner, lastFour} from './issue-checks.js';
import {renderExtract} from './pdf/extract-pdf.js';
import {pdfKeyOf} from './pdf-store.js';
import {NO_SEAL_MESSAGE} from './seal/sealers.js';
import {sealPdf} from './seal/seal-pdf.js';

/** Who an action is recorded as when no person makes it: tests. */
const SYSTEM = {id: 'system', name: 'System'};

/** A token nobody can guess: 32 random bytes, URL-safe (it goes into the extract's QR code). */
export const newToken = () => randomBytes(32).toString('base64url');

/**
 * The register of ownership extracts (README.md). An extract is issued for an owner on a land
 * record's current committed version (read from land-records) once that version is on the
 * blockchain (asked of the audit service); it can be revoked with a reason. Each issue and
 * revocation is an event, so it is in the audit trail.
 */
export class ExtractsService {
  constructor({
    repo,
    events,
    records = null,
    anchoring = null,
    proofs = null,
    files = null,
    sealer = null,
    settings = null,
    clock = () => new Date(),
    token = newToken,
  }) {
    this.repo = repo;
    this.events = events;
    this.records = records; // land-records, read with the extracts service's token
    this.anchoring = anchoring; // the audit service: is a version on the blockchain
    this.proofs = proofs; // the audit service: the version's proof, attached to the PDF
    this.files = files; // where the sealed PDFs are kept (packages/storage)
    this.sealer = sealer; // the organisation seal (seal/sealers.js); none: issuing is refused
    this.settings = settings; // the site's texts on the PDF (settings.js)
    this.clock = clock;
    this.token = token;
  }

  /**
   * The registry's seal certificate as anyone may compare it (API-694): its subject, its validity
   * and `sha256`, the SHA-256 of the certificate (DER), lowercase hex. The offline verifier takes
   * that fingerprint (--seal) and refuses an extract sealed with another certificate, also one with
   * the same name. 503 when no seal is set up.
   * @return {!Promise<{subject: string, sha256: string, validFrom: string, validTo: string}>}
   */
  async sealCertificate() {
    // for the public: neutral, not the staff message about setting the seal up
    if (!this.sealer) {
      throw new AppError(
        503,
        'The registry’s seal certificate is not available now.',
      );
    }
    const der = Buffer.from(await this.sealer.certificate());
    const certificate = new X509Certificate(der);
    return {
      // one line, without the escapes Node puts before commas inside a value
      subject: certificate.subject
        .split('\n')
        .map(part => part.replace(/\\(.)/g, '$1'))
        .join(', '),
      sha256: createHash('sha256').update(der).digest('hex'),
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(),
    };
  }

  /** Run `fn` so its writes and the events it publishes are committed together (API-613). */
  atomic(fn) {
    return this.events?.atomic ? this.events.atomic(fn) : fn();
  }

  /**
   * Issue an extract of a land record's current version for one of its owners: `ownerIndex` on
   * version `versionNumber`, the ID number `idNo` typed from the identity document the staff member
   * was shown, `documentSeen` true. checkOwner and checkOnChain say what is refused. The extract's
   * PDF is made, sealed and stored before the register row is written; the row and the issued
   * event carry the PDF's SHA-256 (pdf() gives the PDF).
   */
  async issue(request, actor = SYSTEM) {
    const record = await this.requireRecord(request.recordId);
    const owner = checkOwner(record, request);
    await checkOnChain(this.anchoring, record, request.versionNumber);
    if (!this.sealer) throw new AppError(503, NO_SEAL_MESSAGE);
    const {proof, explorerUrl} = await this.requireProof(record);
    const id = randomUUID();
    const extract = {
      id,
      recordId: record.id,
      recordNo: record.recordNo,
      versionNumber: request.versionNumber,
      issuedById: actor.id,
      issuedByName: actor.name,
      ownerIndex: owner.index,
      ownerName: owner.name,
      ownerIdLast4: lastFour(owner.idNo),
      documentSeen: true,
      issuedAt: this.clock(),
      token: this.token(),
      status: 'valid',
      revokedAt: null,
      revokedById: null,
      revokedByName: null,
      revokeReason: null,
      pdfSha256: null, // once the sealed PDF is stored
      pdfKey: pdfKeyOf(id),
    };
    const pdf = await this.sealedPdf(extract, record, proof, explorerUrl);
    extract.pdfSha256 = (
      await this.files.put({
        key: extract.pdfKey,
        body: pdf,
        contentType: 'application/pdf',
      })
    ).sha256;
    // the register row and its event are committed together (API-613)
    try {
      await this.atomic(async () => {
        await this.repo.addExtract(extract);
        await this.events?.publish(
          'extracts.extract.issued',
          {
            ...this.eventData(extract),
            issuedFor: {name: extract.ownerName},
            pdfSha256: extract.pdfSha256,
          },
          {actor},
        );
      });
    } catch (err) {
      // not in the register: the PDF is not kept either
      await this.files.delete(extract.pdfKey).catch(() => {});
      throw err;
    }
    return withCurrent(extract, record);
  }

  /**
   * The proof of the record's current version from the audit service, for the PDF: confirmed on
   * the blockchain, and for the seal land-records holds for that version.
   */
  async requireProof(record) {
    if (!this.proofs) {
      throw new AppError(
        503,
        'The proof that the version is on the blockchain cannot be read now: try again later',
      );
    }
    const found = await this.proofs.recordProof(
      record.id,
      record.current.versionNumber,
    );
    if (found.proof.status !== 'confirmed') {
      throw new ConflictError(
        `Version ${record.current.versionNumber} of ${record.recordNo} is not on the blockchain yet: an extract can be issued once it is`,
        {status: found.proof.status},
      );
    }
    if (found.proof.item?.seal !== record.current.seal) {
      throw new ConflictError(
        `The fingerprint of version ${record.current.versionNumber} of ${record.recordNo} does not match the one on the blockchain: no extract can be issued. Tell the administrator.`,
      );
    }
    return found;
  }

  /** The extract's PDF, made and sealed (pdf/extract-pdf.js, seal/seal-pdf.js). */
  async sealedPdf(extract, record, proof, explorerUrl) {
    const pdfDoc = await renderExtract({
      extract,
      record,
      proof,
      explorerUrl,
      settings: this.settings,
    });
    const {org} = this.settings;
    return sealPdf(pdfDoc, this.sealer, {
      name: org.subtitle ? `${org.name}, ${org.subtitle}` : org.name,
      reason: `Ownership extract ${extract.id} of ${record.recordNo}, version ${extract.versionNumber}`,
      signingTime: extract.issuedAt,
    });
  }

  /**
   * "Download again": the extract's sealed PDF, the exact bytes issued, checked against the SHA-256
   * in the register. A revoked extract is not given out again.
   * @return {!Promise<{extract: !Object, pdf: !Buffer}>}
   */
  async pdf(id) {
    const extract = await this.repo.getExtract(id);
    if (!extract) throw new NotFoundError('Extract not found');
    if (extract.status !== 'valid') {
      throw new ConflictError(
        'The extract is revoked: it cannot be downloaded again. Issue a new one.',
      );
    }
    const chunks = [];
    for await (const chunk of await this.files.getStream(extract.pdfKey)) {
      chunks.push(chunk);
    }
    const pdf = Buffer.concat(chunks);
    if (createHash('sha256').update(pdf).digest('hex') !== extract.pdfSha256) {
      throw new AppError(
        500,
        'The stored PDF of this extract does not match the register: it cannot be given out. Tell the administrator.',
      );
    }
    return {extract, pdf};
  }

  /** The extracts of a land record, newest first, each saying whether its version is still current. */
  async listForRecord(recordId) {
    const record = await this.requireRecord(recordId);
    const items = await this.repo.listExtracts(recordId);
    return {items: items.map(extract => withCurrent(extract, record))};
  }

  /** Revoke a valid extract, with the reason. A revoked extract stays in the register. */
  async revoke(id, {reason} = {}, actor = SYSTEM) {
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestError('Give the reason');
    const extract = await this.repo.getExtract(id);
    if (!extract) throw new NotFoundError('Extract not found');
    if (extract.status !== 'valid') {
      throw new ConflictError('The extract is already revoked');
    }
    let revoked;
    await this.atomic(async () => {
      revoked = await this.repo.revokeExtract(id, {
        revokedAt: this.clock(),
        revokedById: actor.id,
        revokedByName: actor.name,
        revokeReason: why,
      });
      // revoked by someone else meanwhile
      if (!revoked) throw new ConflictError('The extract is already revoked');
      await this.events?.publish(
        'extracts.extract.revoked',
        {...this.eventData(revoked), reason: why},
        {actor},
      );
    });
    // the revocation is saved: a land record that cannot be read now must not turn it into an error
    let record;
    try {
      record = await this.requireRecord(revoked.recordId);
    } catch {
      return {...shown(revoked), isCurrentVersion: null};
    }
    return withCurrent(revoked, record);
  }

  /** The land record with its current version, from land-records. */
  async requireRecord(recordId) {
    if (!this.records) {
      throw new AppError(503, 'The land records are not available');
    }
    const record = await this.records.getRecord(recordId);
    if (!record) throw new NotFoundError('Land record not found');
    return record;
  }

  /** What the events say about an extract: never the token or the owner's ID number. */
  eventData(extract) {
    return {
      extractId: extract.id,
      recordId: extract.recordId,
      recordNo: extract.recordNo,
      versionNumber: extract.versionNumber,
    };
  }
}

/**
 * The register row as answered, with `isCurrentVersion`: its version is still the record's current
 * one. Where the PDF is stored stays inside the service.
 */
function withCurrent(extract, record) {
  return {
    ...shown(extract),
    isCurrentVersion: extract.versionNumber === record.currentVersion,
  };
}

/** The register row without the PDF's storage key. */
function shown(extract) {
  const {pdfKey: _pdfKey, ...rest} = extract;
  return rest;
}
