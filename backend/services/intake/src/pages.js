import { PDFDocument } from 'pdf-lib';

/**
 * Number of pages in an uploaded file: PDFs are counted, images are one page. Returns null when
 * a PDF cannot be parsed (the model may still read it; the count then comes from its answer).
 */
export async function countPages(buffer, mimeType) {
    if (mimeType !== 'application/pdf') return 1;
    try {
        const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
        return pdf.getPageCount();
    } catch {
        return null;
    }
}
