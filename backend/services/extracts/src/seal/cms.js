import {createHash} from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/** The object identifiers the seal's CMS SignedData uses (RFC 5652, RFC 5035, RFC 5758). */
export const OID = Object.freeze({
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
});

const sha256 = bytes => createHash('sha256').update(bytes).digest();

/** The ArrayBuffer of exactly these bytes (asn1js and pkijs take ArrayBuffers). */
const arrayBuffer = bytes => new Uint8Array(bytes).buffer;

/** The signature algorithm for the certificate's key: ECDSA or RSA, always with SHA-256. */
export function signatureAlgorithmOf(certificate) {
  const keyAlgorithm = certificate.subjectPublicKeyInfo.algorithm.algorithmId;
  if (keyAlgorithm === OID.ecPublicKey) return OID.ecdsaWithSha256;
  if (keyAlgorithm === OID.rsaEncryption) return OID.sha256WithRsa;
  throw new Error(
    `The seal certificate's key is neither ECDSA nor RSA (${keyAlgorithm})`,
  );
}

/** One signed attribute. */
const attribute = (type, value) => new pkijs.Attribute({type, values: [value]});

/**
 * The signed attributes of a PAdES baseline (B-B) signature: the content type, the digest of the
 * signed bytes, and the seal certificate's hash (ESS signing-certificate-v2, so the certificate
 * cannot be swapped). No signing time: in PAdES it is the signature dictionary's /M.
 */
function signedAttributes(content, certificateDer) {
  const essCertIdV2 = new asn1js.Sequence({
    // hashAlgorithm left out: SHA-256 is the default
    value: [
      new asn1js.OctetString({valueHex: arrayBuffer(sha256(certificateDer))}),
    ],
  });
  const signingCertificateV2 = new asn1js.Sequence({
    value: [new asn1js.Sequence({value: [essCertIdV2]})],
  });
  const attributes = [
    attribute(OID.contentType, new asn1js.ObjectIdentifier({value: OID.data})),
    attribute(
      OID.messageDigest,
      new asn1js.OctetString({valueHex: arrayBuffer(sha256(content))}),
    ),
    attribute(OID.signingCertificateV2, signingCertificateV2),
  ];
  // DER: the elements of a SET OF in the order of their encodings
  const encoded = a => Buffer.from(a.toSchema().toBER());
  attributes.sort((a, b) => Buffer.compare(encoded(a), encoded(b)));
  return new pkijs.SignedAndUnsignedAttributes({type: 0, attributes});
}

/**
 * A detached CMS SignedData (RFC 5652) over `content`, the bytes of the PDF the signature covers,
 * for the PDF's signature dictionary (SubFilter ETSI.CAdES.detached). `sign(bytes)` is the
 * Sealer's: it signs the DER of the signed attributes with the seal's key and returns the
 * signature (ECDSA as DER, or RSA PKCS #1 v1.5); the key itself is never here.
 * @param {{content: !Buffer, certificateDer: !Buffer, sign: function(!Buffer): !Promise<!Buffer>}} input
 * @return {!Promise<!Buffer>} the DER of the ContentInfo
 */
export async function buildSignedData({content, certificateDer, sign}) {
  const certificate = pkijs.Certificate.fromBER(arrayBuffer(certificateDer));
  const signedAttrs = signedAttributes(content, certificateDer);
  // what is signed: the attributes as a SET OF, not with the [0] tag they carry in SignerInfo
  const toSign = Buffer.from(signedAttrs.toSchema().toBER());
  toSign[0] = 0x31;
  const signature = await sign(toSign);

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
    }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({algorithmId: OID.sha256}),
    signedAttrs,
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: signatureAlgorithmOf(certificate),
    }),
    signature: new asn1js.OctetString({valueHex: arrayBuffer(signature)}),
  });
  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [
      new pkijs.AlgorithmIdentifier({algorithmId: OID.sha256}),
    ],
    // detached: the content is the PDF around the signature, not in here
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID.data,
    }),
    certificates: [certificate],
    signerInfos: [signerInfo],
  });
  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.signedData,
    content: signedData.toSchema(true),
  });
  return Buffer.from(contentInfo.toSchema().toBER());
}

/** A PEM certificate as DER; the first certificate when the text holds a chain. */
export function pemToDer(pem) {
  const match =
    /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(
      String(pem ?? '').replace(/\\n/g, '\n'),
    );
  if (!match) throw new Error('The seal certificate is not a PEM certificate');
  return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
}
