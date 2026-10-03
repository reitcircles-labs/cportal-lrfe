/**
 * A sample scan for the tests: a fictitious deed of transfer, drawn as a one-page PDF by the
 * browser itself, so no binary file is kept in the repository. Its wording matches the intake
 * service's canned AI answer (EXTRACTION_PROVIDER=mock: T 2210/2008, Erf 1873, Klein Windhoek),
 * so what the reviewer sees next to the scan agrees with it. Every name and number is invented.
 *
 * Intake refuses a file it has seen before and the EDRMS files each deed number once, so tests that
 * need several deeds pass a deed number (put it in the file name too: the canned AI reads it from
 * there, see sampleDeed) and get distinct bytes from the marker printed in the footer.
 */
import type { Browser } from '@playwright/test';

const deedHtml = (deedNo: string, marker: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.6 Georgia, serif; margin: 56px 64px; color: #111; }
  h1 { font-size: 20px; text-align: center; letter-spacing: .08em; margin: 0 0 4px; }
  .no { text-align: center; margin: 0 0 28px; }
  .stamp { position: absolute; top: 40px; right: 48px; border: 2px solid #555; padding: 6px 10px; font-size: 11px; transform: rotate(-4deg); }
  p { text-align: justify; margin: 0 0 12px; }
  .sig { margin-top: 48px; display: flex; justify-content: space-between; font-size: 12px; }
  .foot { position: absolute; bottom: 40px; left: 64px; right: 64px; font-size: 10px; color: #666; text-align: center; }
</style></head><body>
  <div class="stamp">DEEDS REGISTRY · WINDHOEK<br>14 MAR 2008</div>
  <h1>DEED OF TRANSFER</h1>
  <p class="no">No. ${deedNo}</p>
  <p>BE IT HEREBY MADE KNOWN THAT H. van Wyk, conveyancer, appeared before me, the Registrar of Deeds, at
  Windhoek, duly authorised by power of attorney granted by Johannes Shikongo (Identity No. 61042500187).</p>
  <p>AND THE APPEARER DECLARED that the transferor had truly and legally sold the property for the sum of
  N$ 640 000,00, and ceded and transferred it in full and free property to Petrus Nghishidi (Identity No.
  72110800345) and Maria Nghishidi (Identity No. 75060200418), married in community of property, in ½ share each:</p>
  <p><b>Erf 1873, Klein Windhoek</b>, situated in the Municipality of Windhoek, Registration Division "K",
  Khomas Region; measuring 1 214 square metres; as will more fully appear from Diagram S.G. No. A 412/2007,
  and held under Deed of Transfer No. T 1502/1996.</p>
  <div class="sig"><span>Signature of appearer</span><span>Registrar of Deeds</span></div>
  <div class="foot">SAMPLE DOCUMENT FOR AUTOMATED TESTS · ALL NAMES AND NUMBERS ARE FICTITIOUS${marker ? ` · ${marker}` : ''}</div>
</body></html>`;

export async function sampleDeedPdf(browser: Browser, { deedNo = 'T 2210/2008', marker = '' } = {}): Promise<Buffer> {
    const page = await browser.newPage();
    try {
        await page.setContent(deedHtml(deedNo, marker));
        return await page.pdf({ format: 'A4', printBackground: true });
    } finally {
        await page.close();
    }
}
