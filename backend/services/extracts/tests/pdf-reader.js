import {X509Certificate, createHash, verify as cryptoVerify} from 'node:crypto';
import * as asn1js from 'asn1js';
import jsQR from 'jsqr';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import * as pkijs from 'pkijs';

/** The characters of Windows-1252 (WinAnsi) between 0x80 and 0x9F the extract can use. */
const WIN_ANSI = {
  0x85: '…',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
};

/** The bytes of a stream object, decoded (inflated). */
const streamBytes = stream =>
  Buffer.from(
    stream instanceof PDFRawStream
      ? decodePDFRawStream(stream).decode()
      : stream.getContents(),
  );

/** The decoded content streams of a page, as text. */
function pageContent(page) {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => page.doc.context.lookup(ref))
      : [contents];
  return streams.map(s => streamBytes(s).toString('latin1')).join('\n');
}

/** A WinAnsi hex string as text. */
const decodeHex = hex =>
  [...Buffer.from(hex, 'hex')]
    .map(code => WIN_ANSI[code] ?? String.fromCharCode(code))
    .join('');

/**
 * What a sealed extract holds, read back the way the tests need it: the text of each page (each
 * drawn line once, in drawing order), the QR code's rectangles and the document itself.
 */
export async function readPdf(bytes) {
  const pdfDoc = await PDFDocument.load(bytes);
  const pages = pdfDoc.getPages().map(page => {
    const content = pageContent(page);
    const lines = [...content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map(m =>
      decodeHex(m[1]),
    );
    return {content, lines};
  });
  const lines = pages.flatMap(page => page.lines);
  return {pdfDoc, pages, lines, text: lines.join(' ')};
}

/**
 * The text of the QR code on the first page, decoded with a QR reader from the rectangles drawn in
 * its marked content section (extract-pdf.js drawQr), as a scanner would see them.
 */
export function readQr(page) {
  const section = /\/QR BMC([\s\S]*?)EMC/.exec(page.content);
  if (!section) throw new Error('No QR code on the page');
  const rects = [
    ...section[1].matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g),
  ].map(m => m.slice(1, 5).map(Number));
  const cell = Math.min(...rects.map(r => r[3]));
  const left = Math.min(...rects.map(r => r[0]));
  const top = Math.max(...rects.map(r => r[1] + r[3]));
  const size = Math.round(
    (Math.max(...rects.map(r => r[0] + r[2])) - left) / cell,
  );
  const quiet = 4;
  const scale = 4;
  const side = (size + 2 * quiet) * scale;
  const image = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const [x, y, width, height] of rects) {
    const column = Math.round((x - left) / cell);
    const row = Math.round((top - (y + height)) / cell);
    const columns = Math.round(width / cell);
    for (let py = 0; py < scale; py++) {
      for (let px = 0; px < columns * scale; px++) {
        const at =
          ((quiet + row) * scale + py) * side + (quiet + column) * scale + px;
        image.fill(0, at * 4, at * 4 + 3);
      }
    }
  }
  return jsQR(image, side, side)?.data ?? null;
}

/** The files attached inside the PDF, by name, as Buffers. */
export function attachments(pdfDoc) {
  const names = pdfDoc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const embedded = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const list = embedded?.lookupMaybe(PDFName.of('Names'), PDFArray);
  const files = {};
  for (let i = 0; list && i < list.size(); i += 2) {
    const name = list.lookup(i).decodeText();
    const spec = list.lookup(i + 1, PDFDict);
    const stream = spec
      .lookup(PDFName.of('EF'), PDFDict)
      .lookup(PDFName.of('F'));
    files[name] = streamBytes(stream);
  }
  return files;
}

/** Every stream of the document, decoded, as one latin1 text: to search everything it holds. */
export function allStreams(pdfDoc) {
  return pdfDoc.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFRawStream)
    .map(([, stream]) => {
      try {
        return streamBytes(stream).toString('latin1');
      } catch {
        return '';
      }
    })
    .join('\n');
}

/**
 * The PDF's signature checked, as a PDF reader checks it: the bytes its /ByteRange covers (the
 * whole file but the signature), their digest in the signed attributes, and the signature over the
 * signed attributes with the public key of the certificate in the CMS (node:crypto, and pkijs as a
 * second opinion).
 */
export async function checkSignature(bytes) {
  const pdf = Buffer.from(bytes);
  const text = pdf.toString('latin1');
  const range = /\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\s*\]/.exec(text);
  const subFilter = /\/SubFilter \/([A-Za-z0-9.]+)/.exec(text)?.[1];
  const [start, length, after, rest] = range.slice(1).map(Number);
  const content = Buffer.concat([
    pdf.subarray(start, start + length),
    pdf.subarray(after, after + rest),
  ]);
  const hex = pdf.subarray(start + length + 1, after - 1).toString('latin1');
  const der = Buffer.from(hex.replace(/(00)+$/, ''), 'hex');
  const asn1 = asn1js.fromBER(new Uint8Array(der).buffer);
  const contentInfo = new pkijs.ContentInfo({schema: asn1.result});
  const signedData = new pkijs.SignedData({schema: contentInfo.content});
  const [signerInfo] = signedData.signerInfos;
  const certificateDer = Buffer.from(
    signedData.certificates[0].toSchema().toBER(),
  );
  const signed = Buffer.from(signerInfo.signedAttrs.toSchema().toBER());
  signed[0] = 0x31;
  const attribute = type =>
    signerInfo.signedAttrs.attributes.find(a => a.type === type)?.values[0];
  const messageDigest = Buffer.from(
    attribute('1.2.840.113549.1.9.4').valueBlock.valueHexView,
  );
  const digestMatches = messageDigest.equals(
    createHash('sha256').update(content).digest(),
  );
  const signatureValid = cryptoVerify(
    'sha256',
    signed,
    {
      key: new X509Certificate(certificateDer).publicKey,
      dsaEncoding: 'der',
    },
    Buffer.from(signerInfo.signature.valueBlock.valueHexView),
  );
  // pkijs answers a failed check with an error or with signatureVerified false
  const pkijsResult = await signedData
    .verify({
      signer: 0,
      data: new Uint8Array(content).buffer,
      checkChain: false,
      extendedMode: true,
    })
    .catch(() => ({signatureVerified: false}));
  return {
    subFilter,
    coversAllButSignature: start === 0 && after + rest === pdf.length,
    digestMatches,
    signatureValid,
    pkijsValid: pkijsResult.signatureVerified === true,
    certificateDer,
    signedAttributeTypes: signerInfo.signedAttrs.attributes.map(a => a.type),
  };
}
