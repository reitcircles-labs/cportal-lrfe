import { expect } from 'chai';
import { PDFDocument } from 'pdf-lib';
import { countPages } from '../src/pages.js';

describe('page counting', () => {
    it('counts PDF pages, treats images as one page, and returns null for unreadable PDFs', async () => {
        const pdf = await PDFDocument.create();
        for (let i = 0; i < 3; i++) pdf.addPage();
        expect(await countPages(Buffer.from(await pdf.save()), 'application/pdf')).to.equal(3);
        expect(await countPages(Buffer.from('png'), 'image/png')).to.equal(1);
        expect(await countPages(Buffer.from('%PDF-1.7 broken'), 'application/pdf')).to.equal(null);
    });
});
