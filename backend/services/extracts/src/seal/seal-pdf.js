import {pdflibAddPlaceholder} from '@signpdf/placeholder-pdf-lib';
import {SignPdf} from '@signpdf/signpdf';
import {Signer, SUBFILTER_ETSI_CADES_DETACHED} from '@signpdf/utils';
import {buildSignedData} from './cms.js';

/**
 * Room for the CMS signature in the PDF, in bytes: the seal certificate and the signature take
 * about 1 to 2 KB; a longer certificate (RSA 4096, long names) still fits.
 */
const SIGNATURE_ROOM = 8192;

/** The @signpdf signer that has a Sealer sign: the CMS SignedData over the PDF's byte range. */
class SealSigner extends Signer {
  constructor(sealer) {
    super();
    this.sealer = sealer;
  }

  /** The detached CMS for `content`, the PDF without the signature's own placeholder. */
  async sign(content) {
    return buildSignedData({
      content,
      certificateDer: await this.sealer.certificate(),
      sign: bytes => this.sealer.sign(bytes),
    });
  }
}

/**
 * The PDF document saved with the organisation seal: a PAdES baseline (B-B) signature
 * (SubFilter ETSI.CAdES.detached) over the whole file but the signature itself, made by `sealer`.
 * `name` is who seals (the registry), `signingTime` the issue date (the signature's /M).
 * @return {!Promise<!Buffer>} the sealed PDF
 */
export async function sealPdf(pdfDoc, sealer, {name, reason, signingTime}) {
  pdflibAddPlaceholder({
    pdfDoc,
    reason,
    contactInfo: '',
    name,
    location: '',
    signingTime,
    signatureLength: SIGNATURE_ROOM * 2,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  });
  // without object streams: the signature dictionary must be found in the saved bytes
  const unsigned = Buffer.from(await pdfDoc.save({useObjectStreams: false}));
  return new SignPdf().sign(unsigned, new SealSigner(sealer));
}
