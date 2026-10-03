#!/usr/bin/env node
/**
 * Draws the sample documents for testers (docs/samples/*.pdf) with the browser the end-to-end
 * tests use. Every person, number and parcel detail is invented; each page says so in its footer.
 *
 *   cd e2e && node ../angular-app/docs/samples/generate.mjs           the standard set (this folder)
 *   cd e2e && node ../angular-app/docs/samples/generate.mjs --set 2   a set with other numbers, in set-2/
 *
 * The standard set is the chain of title of Erf 1873, Klein Windhoek, the parcel the Land record
 * screen knows. A system files each deed number once, so when the standard set has already been
 * filed on a shared test system, testers can make their own with --set (live screens only: the
 * Land record screen only knows Erf 1873).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const { chromium } = await import(join(REPO, 'e2e', 'node_modules', '@playwright', 'test', 'index.mjs'));

const setArg = process.argv.indexOf('--set');
const set = setArg > 0 ? Number(process.argv[setArg + 1]) : 1;
if (!Number.isInteger(set) || set < 1) { console.error('--set takes a whole number, 2 or more'); process.exit(2); }
const out = set === 1 ? HERE : join(HERE, `set-${set}`);
mkdirSync(out, { recursive: true });

// Numbers move with the set, so a set's deeds do not clash with another set's.
const o = set === 1 ? 0 : set * 1000;
const erf = 1873 + (set === 1 ? 0 : set * 100);
const N = {
    erf: `Erf ${erf}`, grant: `G ${88 + o}/1978`, t1996: `T ${1502 + o}/1996`, sg: `A ${412 + o}/2007`,
    t2008: `T ${2210 + o}/2008`, t2019: `T ${4521 + o}/2019`, estate: `E ${1830 + o}/2018`
};

const STYLE = `
  @page { size: A4; margin: 0; }
  body { font: 12.5px/1.65 Georgia, 'Times New Roman', serif; margin: 0; padding: 54px 64px 90px; color: #161616; position: relative; min-height: 1000px; }
  h1 { font-size: 21px; text-align: center; letter-spacing: .1em; margin: 6px 0 2px; }
  .no { text-align: center; margin: 0 0 22px; font-size: 14px; }
  .office { text-align: center; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #333; }
  p { text-align: justify; margin: 0 0 11px; }
  .stamp { position: absolute; top: 34px; right: 46px; border: 2px solid #4b4b4b; padding: 5px 9px; font: 10px/1.35 Arial, sans-serif; text-align: center; transform: rotate(-4deg); color: #333; }
  .sig { margin-top: 40px; display: flex; justify-content: space-between; font-size: 11.5px; }
  .sig div { border-top: 1px solid #444; padding-top: 4px; width: 42%; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 8px 0 14px; }
  td, th { border: 1px solid #777; padding: 4px 7px; text-align: left; }
  .foot { position: fixed; bottom: 30px; left: 64px; right: 64px; font: 9.5px Arial, sans-serif; color: #666; text-align: center; border-top: 1px solid #ccc; padding-top: 6px; }
  .note { font: italic 15px 'Comic Sans MS', 'Segoe Print', cursive; color: #1b3d8f; }
  .letterhead { font: 600 15px Arial, sans-serif; border-bottom: 2px solid #222; padding-bottom: 6px; margin-bottom: 18px; }
`;
const page = (body, label) => `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}
  <div class="foot">SAMPLE DOCUMENT FOR TESTING THE DEEDS REGISTRY PORTAL · ALL NAMES, NUMBERS AND DETAILS ARE FICTITIOUS · ${label}</div></body></html>`;

const DOCS = [
    {
        file: `01-${N.grant.replace(/[ /]/g, '-')}-deed-of-grant.pdf`,
        html: page(`
  <div class="stamp">DEEDS REGISTRY<br>WINDHOEK<br>2 MAY 1978</div>
  <div class="office">Deeds Registry · Windhoek</div>
  <h1>DEED OF GRANT</h1><p class="no">No. ${N.grant}</p>
  <p>BE IT HEREBY MADE KNOWN THAT the State, acting through the Administration, hereby grants unto the
  <b>MUNICIPALITY OF WINDHOEK</b>, its successors in title or assigns, in full and free property,</p>
  <p><b>${N.erf}, Klein Windhoek</b>, situated in the Municipality of Windhoek, Registration Division "K",
  Khomas Region; measuring 1 214 (one thousand two hundred and fourteen) square metres; as will more fully
  appear from the General Plan of the township Klein Windhoek,</p>
  <p>for the purpose of township establishment, subject to the conditions imposed by the Townships and
  Division of Land Ordinance and to the reservation of all rights to minerals in favour of the State.</p>
  <p>Registered at the Deeds Registry, Windhoek, on 2 May 1978.</p>
  <div class="sig"><div>For and on behalf of the State</div><div>Registrar of Deeds</div></div>`, 'DEED OF GRANT ' + N.grant)
    },
    {
        file: `02-${N.t1996.replace(/[ /]/g, '-')}-deed-of-transfer.pdf`,
        html: page(`
  <div class="stamp">DEEDS REGISTRY<br>WINDHOEK<br>19 AUG 1996</div>
  <div class="office">Deeds Registry · Windhoek</div>
  <h1>DEED OF TRANSFER</h1><p class="no">No. ${N.t1996}</p>
  <p>BE IT HEREBY MADE KNOWN THAT A. Kahuure, appeared before me, the Registrar of Deeds at Windhoek, being
  duly authorised thereto by a power of attorney granted by the <b>MUNICIPALITY OF WINDHOEK</b>, dated
  4 June 1996;</p>
  <p>AND THE APPEARER DECLARED that the said Municipality had truly and legally sold the property hereinafter
  described for the sum of <b>N$ 85 000,00</b> (eighty-five thousand Namibia dollars), and that he, in his said
  capacity, did by these presents cede and transfer in full and free property to and on behalf of</p>
  <p><b>JOHANNES SHIKONGO</b>, Identity No. 61042500187, unmarried,</p>
  <p><b>${N.erf}, Klein Windhoek</b>, situated in the Municipality of Windhoek, Registration Division "K", Khomas
  Region; measuring 1 214 square metres; first registered by Deed of Grant No. ${N.grant} and held under
  the said Deed of Grant No. ${N.grant}.</p>
  <p>Registered at the Deeds Registry, Windhoek, on 19 August 1996.</p>
  <div class="sig"><div>Signature of appearer</div><div>Registrar of Deeds</div></div>`, 'DEED OF TRANSFER ' + N.t1996)
    },
    {
        file: `03-SG-${N.sg.replace(/[ /]/g, '-')}-diagram.pdf`,
        html: page(`
  <div class="office">Office of the Surveyor-General · Windhoek</div>
  <h1>DIAGRAM</h1><p class="no">S.G. No. ${N.sg}</p>
  <svg viewBox="0 0 520 330" width="100%" height="330" style="margin:4px 0 10px">
    <polygon points="70,60 300,40 450,110 430,270 230,300 90,250" fill="#f4f1e6" stroke="#222" stroke-width="2"/>
    ${[['A', 70, 60], ['B', 300, 40], ['C', 450, 110], ['D', 430, 270], ['E', 230, 300], ['F', 90, 250]]
                .map(([b, x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="#222"/><text x="${x - 16}" y="${y - 8}" font-family="Arial" font-size="15">${b}</text>`).join('')}
    <text x="200" y="175" font-family="Georgia" font-size="17">${N.erf}</text>
    <text x="215" y="198" font-family="Arial" font-size="12">1 214 m²</text>
    <text x="250" y="325" font-family="Arial" font-size="11">Scale 1 : 500</text>
    <text x="470" y="40" font-family="Arial" font-size="13">N ↑</text>
  </svg>
  <table><tr><th>Side</th><th>Length (m)</th><th>Direction</th></tr>
    <tr><td>AB</td><td>35,42</td><td>86°10'</td></tr><tr><td>BC</td><td>25,18</td><td>116°20'</td></tr>
    <tr><td>CD</td><td>24,61</td><td>187°05'</td></tr><tr><td>DE</td><td>30,77</td><td>261°30'</td></tr>
    <tr><td>EF</td><td>22,94</td><td>298°15'</td></tr><tr><td>FA</td><td>29,88</td><td>357°40'</td></tr></table>
  <p>The figure lettered <b>A B C D E F</b> represents <b>${N.erf}, Klein Windhoek</b>, situated in the Municipality of
  Windhoek, Registration Division "K", Khomas Region, measuring <b>1 214 square metres</b>. Beacons A–F (6): iron pegs.</p>
  <p>Surveyed on 22 October 2007 by me, <b>L. Hamutenya</b>, Professional Land Surveyor, PLS 0417.</p>
  <p>Approved by the Surveyor-General on 30 November 2007.</p>
  <div class="sig"><div>Land surveyor</div><div>Surveyor-General</div></div>`, 'SG DIAGRAM ' + N.sg)
    },
    {
        file: `04-${N.t2008.replace(/[ /]/g, '-')}-deed-of-transfer.pdf`,
        html: page(`
  <div class="stamp">DEEDS REGISTRY<br>WINDHOEK<br>14 MAR 2008</div>
  <div class="office">Deeds Registry · Windhoek</div>
  <h1>DEED OF TRANSFER</h1><p class="no">No. ${N.t2008}</p>
  <p>BE IT HEREBY MADE KNOWN THAT H. van Wyk, conveyancer, appeared before me, the Registrar of Deeds at
  Windhoek, duly authorised by power of attorney granted by <b>JOHANNES SHIKONGO</b> (Identity No. 61042500187).</p>
  <p>AND THE APPEARER DECLARED that the transferor had truly and legally sold the property for the sum of
  <b>N$ 640 000,00</b>, and ceded and transferred it in full and free property to</p>
  <p><b>PETRUS NGHISHIDI</b>, Identity No. 72110800345, and <b>MARIA NGHISHIDI</b>, Identity No. 75060200418,
  married in community of property, in ½ share each:</p>
  <p><b>${N.erf}, Klein Windhoek</b>, situated in the Municipality of Windhoek, Registration Division "K", Khomas
  Region; measuring 1 214 square metres; as will more fully appear from Diagram S.G. No. ${N.sg}, and held under
  Deed of Transfer No. ${N.t1996}.</p>
  <p>Registered at the Deeds Registry, Windhoek, on 14 March 2008.</p>
  <div class="sig"><div>Signature of appearer</div><div>Registrar of Deeds</div></div>`, 'DEED OF TRANSFER ' + N.t2008)
    },
    {
        file: `05-${N.t2019.replace(/[ /]/g, '-')}-deed-of-transfer-estate.pdf`,
        html: page(`
  <div class="stamp">DEEDS REGISTRY<br>WINDHOEK<br>9 JUL 2019</div>
  <div class="office">Deeds Registry · Windhoek</div>
  <h1>DEED OF TRANSFER</h1><p class="no">No. ${N.t2019}</p>
  <p>BE IT HEREBY MADE KNOWN THAT D. Amukoto, appeared before me, the Registrar of Deeds at Windhoek, in his
  capacity as the duly appointed executor in the <b>ESTATE OF THE LATE PETRUS NGHISHIDI</b>, Master's
  Reference No. ${N.estate}, the deceased having been married in community of property to Maria Nghishidi;</p>
  <p>AND THE APPEARER DECLARED that, in terms of the liquidation and distribution account, the deceased's
  undivided ½ share in the property hereinafter described devolves by <b>inheritance</b>, no consideration
  being payable, upon</p>
  <p><b>NDAPEWA NGHISHIDI</b>, Identity No. 98030100562, and <b>TOMAS NGHISHIDI</b>, Identity No. 0111250379
  <span class="note">&nbsp;← 01112500379 (digit omitted, corrected on lodgement · RD)</span>, both unmarried,
  in ¼ share each:</p>
  <p><b>${N.erf}, Klein Windhoek</b>, situated in the Municipality of Windhoek, Registration Division "K", Khomas
  Region; measuring 1 214 square metres; held under Deed of Transfer No. ${N.t2008}.</p>
  <p>Registered at the Deeds Registry, Windhoek, on 9 July 2019.</p>
  <div class="sig"><div>Executor</div><div>Registrar of Deeds</div></div>`, 'DEED OF TRANSFER ' + N.t2019)
    },
    {
        file: `06-practice-reject-cover-letter.pdf`,
        html: page(`
  <div class="letterhead">Van Wyk &amp; Partners · Conveyancers<br><span style="font:400 11px Arial">12 Fidel Castro Street · Windhoek · Tel. 061 000 000</span></div>
  <p>The Registrar of Deeds<br>Deeds Registry<br>Windhoek</p>
  <p>14 March 2008</p>
  <p><b>Re: Lodgement, ${N.erf}, Klein Windhoek · Shikongo / Nghishidi</b></p>
  <p>Dear Sir or Madam,</p>
  <p>We enclose for registration the deed of transfer in respect of the above property, together with the
  power of attorney, the transfer duty receipt and the rates clearance certificate. Kindly advise our office
  should any further documents be required.</p>
  <p>Yours faithfully,</p>
  <p style="margin-top:36px">H. van Wyk<br>Conveyancer</p>`, 'COVER LETTER (NOT A REGISTRY INSTRUMENT)')
    }
];

const browser = await chromium.launch({ channel: 'chromium' }).catch(() => chromium.launch());
try {
    for (const d of DOCS) {
        const p = await browser.newPage();
        await p.setContent(d.html);
        await p.pdf({ path: join(out, d.file), format: 'A4', printBackground: true });
        await p.close();
        console.log(`${out === HERE ? '' : `set-${set}/`}${d.file}`);
    }
} finally {
    await browser.close();
}
