#!/usr/bin/env node
/**
 * The demo document set (API-716): fictitious scanned land documents for the demo, written as
 * image-only PDFs (no text layer, so the AI really reads them) into this folder, with README.md and
 * SHA256SUMS. Run from the repository root:
 *
 *   node demo/documents/generate.mjs
 *
 * Each page is drawn as HTML by the e2e tests' Chromium, photographed, and given scan effects (a slight
 * rotation, grain, toner, paper tone; the poor scan more of each) in a canvas, then the JPEG pages are
 * put into a PDF. The effects use a fixed seed, so a run draws the same pages again. Every name, ID
 * number and reference is invented; each page carries a small "SPECIMEN · DEMO · FICTITIOUS" mark.
 *
 * Needs the e2e tests' packages (npm ci in e2e/) and the Nimbus fonts (urw-base35) the look is drawn with.
 */
import { createHash } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import('../../e2e/node_modules/playwright/index.mjs').catch(() => {
    console.error('The e2e tests\' packages are missing: run `npm ci` in e2e/ first.');
    process.exit(1);
});

const DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------- the story

/** Erf 2417, Olympia: from the State's grant to today's owners, with a bond. */
const ERF_2417 = {
    property: 'Erf 2417, Olympia',
    township: 'Olympia',
    full: 'ERF NO. 2417 OLYMPIA',
    extent: '1 050 (One Thousand and Fifty) Square Metres',
    sg: 'A 318/1989'
};

/** Erf 815, Ludwigsdorf: bought in 1987, inherited by two heirs in 2021. */
const ERF_815 = {
    property: 'Erf 815, Ludwigsdorf',
    township: 'Ludwigsdorf',
    full: 'ERF NO. 815 LUDWIGSDORF',
    extent: '1 487 (One Thousand Four Hundred and Eighty Seven) Square Metres',
    sg: 'A 1127/1972'
};

/**
 * Where a parcel lies, as a document of that year says it: the Khomas Region exists only from 1992.
 * @param {number} year
 */
function situate(year) {
    return `situate in the Municipality of Windhoek, Registration Division "K"${year >= 1992 ? ', Khomas Region' : ''}`;
}

/** The country in a document's heading: South West Africa until independence in March 1990. */
const country = (year) => (year < 1990 ? 'SOUTH WEST AFRICA' : 'REPUBLIC OF NAMIBIA');

/** The year of a date written as "18 July 2014". */
const yearOf = (date) => Number(date.slice(-4));

const PEOPLE = {
    kambonde: { name: 'ANDREAS KAMBONDE', id: '66030400213' },
    simon: { name: 'SIMON HAUFIKU', id: '79022300471' },
    frieda: { name: 'FRIEDA HAUFIKU', id: '81071100562' },
    shipanga: { name: 'PETRUS NANGOLO SHIPANGA', id: '51120100385' },
    visagie: { name: 'HENDRIK JOHANNES VISAGIE', id: '34081500118' },
    helena: { name: 'HELENA NDAPANDULA SHIPANGA', id: '86051400731' },
    johannes: { name: 'JOHANNES TUHAFENI SHIPANGA', id: '89093000655' }
};

// ------------------------------------------------------------------------------------- page drawing

/** A small seeded random number generator (mulberry32): the same pages on every run. */
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A handwritten-looking signature: a few loops as one SVG path. */
function signature(seed, width = 170) {
    const r = random(seed);
    let d = `M 4 ${28 + r() * 8}`;
    for (let x = 14; x < width - 10; x += 12 + r() * 10) {
        d += ` C ${x - 6} ${4 + r() * 10}, ${x + 4} ${40 + r() * 8}, ${x + 8} ${18 + r() * 14}`;
    }
    return `<svg class="sig" width="${width}" height="48" viewBox="0 0 ${width} 48"><path d="${d}" fill="none" stroke="#1d2a6b" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; width: 794px; height: 1123px; position: relative; color: #161616; background: #fff; }
  .page { position: absolute; inset: 0; padding: 70px 78px 80px; }
  .typed { font: 14px/1.75 'Nimbus Mono PS', 'Nimbus Mono L', monospace; }
  .print { font: 13.5px/1.7 'Nimbus Roman', 'Nimbus Roman No9 L', serif; }
  .sans { font: 13px/1.65 'Nimbus Sans', 'Nimbus Sans L', sans-serif; }
  h1 { font-size: 22px; letter-spacing: .14em; text-align: center; margin: 10px 0 6px; }
  h2 { font-size: 15px; text-align: center; margin: 0 0 22px; letter-spacing: .06em; }
  p { margin: 0 0 13px; text-align: justify; }
  .c { text-align: center; }
  .b { font-weight: bold; }
  .prepared { font-size: 11px; position: absolute; top: 48px; left: 78px; line-height: 1.4; }
  .gov { text-align: center; font-size: 12px; letter-spacing: .12em; margin-top: 4px; }
  .arms { width: 54px; height: 54px; border: 1.5px solid #333; border-radius: 50%; margin: 0 auto;
          font: 8px/1.2 sans-serif; display: flex; align-items: center; justify-content: center; text-align: center; color: #444; }
  .stamp { position: absolute; border: 2.5px solid currentColor; border-radius: 6px; padding: 7px 12px;
           font: bold 12px/1.45 'Nimbus Sans', sans-serif; text-align: center; letter-spacing: .05em; opacity: .78; }
  .sigs { display: flex; justify-content: space-between; margin-top: 30px; font-size: 12px; }
  .sigs > div { width: 44%; text-align: center; }
  .sigs .line { border-top: 1px solid #333; margin-top: 2px; padding-top: 3px; }
  .specimen { position: absolute; bottom: 30px; right: 40px; font: 12px 'Nimbus Sans', sans-serif;
              color: #6e6e6e; letter-spacing: .2em; }
  .pageno { position: absolute; bottom: 30px; left: 0; right: 0; text-align: center; font-size: 11px; color: #555; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #444; padding: 3px 8px; font-size: 12px; }
`;

/** One A4 page of a document, in its typeface, with the demo mark and a page number. */
const page = (font, body, { pageNo = '', extra = '' } = {}) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
    <div class="page ${font}">${body}</div>${extra}
    ${pageNo ? `<div class="pageno">${pageNo}</div>` : ''}
    <div class="specimen">SPECIMEN · DEMO · FICTITIOUS</div></body></html>`;

/** The coat of arms and the country, at the top of a registry document of that year. */
const registryHeader = (year) => `<div class="arms">COAT OF<br>ARMS</div><div class="gov">${country(year)}</div>`;

/** The Registrar's stamp in the corner: registered, when, which number. */
const registered = (number, date, { color = '#2b3b8f', top = 46, right = 60, rotate = -5 } = {}) =>
    `<div class="stamp" style="color:${color};top:${top}px;right:${right}px;transform:rotate(${rotate}deg)">
     REGISTERED<br>DEEDS OFFICE · WINDHOEK<br>${date.toUpperCase()}<br>${number}</div>`;

const sigBlock = (left, right, seed) => `<div class="sigs">
    <div>${signature(seed)}<div class="line">${left}</div></div>
    <div>${signature(seed + 7)}<div class="line">${right}</div></div></div>`;

// ---------------------------------------------------------------------------------- the documents

/**
 * A deed of transfer over two pages, in the wording used for Namibian title deeds. `pronoun` ('he' or
 * 'she') is the appearer's; `estate` makes it a transfer from a deceased estate (executor, Master's
 * reference) instead of a sale.
 * @param {{no: string, date: string, prepared: string, conveyancer: string, pronoun: string, from: !Object,
 *     to: !Array<!Object>, marital: string, share: (string|undefined), price: string, sale: (string|undefined),
 *     land: !Object, prior: string, estate: (!Object|undefined), seed: number, font: (string|undefined)}} deed
 */
function deedOfTransfer({ no, date, prepared, conveyancer, pronoun, from, to, marital, share, price, sale, land, prior, estate, seed, font = 'print' }) {
    const [him, his] = pronoun === 'she' ? ['her', 'her'] : ['him', 'his'];
    const year = yearOf(date);
    const parties = to.map(p => `<span class="b">${p.name}</span> (Identity Number ${p.idShown ?? p.id})`).join(' and ');
    const principal = estate
        ? `<span class="b">${estate.executor}</span>, in her capacity as Executrix Testamentary in the
           <span class="b">ESTATE LATE ${from.name}</span> (Identity Number ${from.id}), Master's Reference No. ${estate.master}
           (hereinafter called "the Transferor")`
        : `<span class="b">${from.name}</span>${from.id ? ` (Identity Number ${from.id})` : ''}`;
    const how = estate
        ? `that the said property devolved upon the transferees by virtue of inheritance in terms of the Last Will and
           Testament of the deceased, and the Liquidation and Distribution Account in the said estate lying for
           inspection having been confirmed by the Master of the High Court`
        : `that the said principal had truly and legally sold the hereinafter mentioned property on ${sale}`;
    const page1 = page(font, `
        <div class="prepared">Prepared by me<br>${signature(seed + 3, 110)}<br>CONVEYANCER<br>${prepared}</div>
        ${registered(no, date)}
        <div style="height:70px"></div>${registryHeader(year)}
        <h1>DEED OF TRANSFER</h1><h2>No. ${no}</h2>
        <p class="b c">BE IT HEREBY MADE KNOWN</p>
        <p>THAT <span class="b">${conveyancer}</span> appeared before me, REGISTRAR OF DEEDS at WINDHOEK, the said Appearer being
        duly authorised thereto by a Power of Attorney granted to ${him} by ${principal}, and signed at Windhoek.</p>
        <p>AND THE APPEARER DECLARED ${how}, and that ${pronoun}, in ${his} capacity aforesaid, did by these presents cede and transfer to
        and on behalf of ${parties}${marital ? `, ${marital}` : ''}${share ? `, in ${share}` : ''}, their Heirs, Executors,
        Administrators or Assigns, in full and free property:</p>
        <p class="b">${land.full}</p>
        <p>${situate(year)};</p>
        <p>MEASURING ${land.extent};</p>
        <p>AS will more fully appear from Diagram S.G. No. ${land.sg}, and HELD by ${prior}.</p>`, { pageNo: 'Page 1 of 2' });
    const page2 = page(font, `
        <div style="height:40px"></div>
        <p>SUBJECT to such conditions as are mentioned or referred to in the aforesaid Deed, and especially subject to the
        conditions imposed in favour of the Local Authority in terms of the Townships and Division of Land Ordinance.</p>
        <p>WHEREFORE the said Appearer, renouncing all the right and title which the said ${estate ? 'estate' : 'principal'}
        heretofore had to the premises, did in consequence also acknowledge the said principal to be entirely dispossessed of,
        and disentitled to the same; and that by virtue of these presents, the said transferees, their Heirs, Executors,
        Administrators or Assigns, now are and henceforth shall be entitled thereto, conformably to local custom, the State,
        however, reserving its rights.</p>
        <p>AND FURTHER that the ${estate ? 'value of the property for the purposes of transfer duty, the property being transferred' : 'purchase price'}
        is <span class="b">${price}</span>.</p>
        <p>IN WITNESS WHEREOF, I the said Registrar, together with the Appearer, have subscribed to these presents, and have caused
        the Seal of Office to be affixed thereto.</p>
        <p>THUS DONE AND EXECUTED at the Office of the REGISTRAR OF DEEDS at WINDHOEK on <span class="b">${date}</span>.</p>
        ${sigBlock('q.q. Appearer', 'In my presence<br>REGISTRAR OF DEEDS', seed)}
        <div class="stamp" style="color:#7a1d1d;bottom:150px;left:90px;transform:rotate(8deg);border-radius:50%;padding:22px 16px">
        SEAL OF<br>OFFICE<br>WINDHOEK</div>`, { pageNo: 'Page 2 of 2' });
    return [page1, page2];
}

/** The State's original grant of a new erf (the first title of its chain). */
function deedOfGrant({ no, date, grantee, land, seed }) {
    const year = yearOf(date);
    return [page('typed', `
        ${registered(no, date, { color: '#4a2f7a', rotate: 4 })}
        <div style="height:60px"></div>${registryHeader(year)}
        <h1>DEED OF GRANT</h1><h2>No. ${no}</h2>
        <p>KNOW ALL MEN WHOM IT MAY CONCERN that the GOVERNMENT OF THE REPUBLIC OF NAMIBIA, herein represented by the Minister
        responsible for lands, has granted and by these presents does grant unto</p>
        <p class="b c">${grantee}</p>
        <p>its successors in title or assigns, the following piece of land, in full and free property:</p>
        <p class="b">${land.full}</p>
        <p>${situate(year)};</p>
        <p>MEASURING ${land.extent};</p>
        <p>AS will more fully appear from Diagram S.G. No. ${land.sg} annexed hereto.</p>
        <p>SUBJECT to the conditions of establishment of the township of ${land.township} and to the rights of the State to all
        minerals and precious stones in and under the land.</p>
        <p>GIVEN under my hand at WINDHOEK on <span class="b">${date}</span>.</p>
        ${sigBlock('MINISTER', 'REGISTRAR OF DEEDS', seed)}`)];
}

/** The 2014 agreement of sale of Erf 2417, typed on two pages. */
function deedOfSale({ seed }) {
    const { kambonde, simon, frieda } = PEOPLE;
    const p1 = page('sans', `
        <div style="height:20px"></div>
        <h1 style="font-size:19px">DEED OF SALE</h1><h2>AGREEMENT OF SALE OF IMMOVABLE PROPERTY</h2>
        <p>entered into by and between</p>
        <p class="b">${kambonde.name}</p><p>Identity Number ${kambonde.id}, unmarried (hereinafter called "the Seller")</p>
        <p>and</p>
        <p class="b">${simon.name} and ${frieda.name}</p>
        <p>Identity Numbers ${simon.id} and ${frieda.id}, married to each other in community of property
        (hereinafter called "the Purchasers")</p>
        <p class="b">1. THE PROPERTY</p>
        <p>The Seller sells to the Purchasers, who buy, ${ERF_2417.property}, ${situate(2014)}, measuring
        1 050 square metres, held by the Seller under Deed of Transfer No. T 3120/1998 ("the property").</p>
        <p class="b">2. PURCHASE PRICE</p>
        <p>The purchase price is <span class="b">N$ 1 450 000,00</span> (One Million Four Hundred and Fifty Thousand Namibia Dollars).</p>
        <p class="b">3. DEPOSIT</p>
        <p>The Purchasers shall pay a deposit of N$ 145 000,00 into the trust account of the transferring attorneys within
        7 (seven) days of signature, to be invested for the Purchasers' benefit until registration of transfer.</p>
        <p class="b">4. SUSPENSIVE CONDITION</p>
        <p>This sale is subject to the Purchasers obtaining a loan of N$ 1 160 000,00 from a financial institution, secured by
        a first mortgage bond over the property, by 30 May 2014.</p>`, { pageNo: 'Page 1 of 2' });
    const p2 = page('sans', `
        <div style="height:30px"></div>
        <p class="b">5. OCCUPATION</p>
        <p>The Purchasers shall take occupation on the date of registration of transfer, from which date all risk and benefit
        in the property passes to them.</p>
        <p class="b">6. TRANSFER</p>
        <p>Transfer shall be registered by GARISEB &amp; KOTZE ATTORNEYS, Windhoek, as soon as possible after the suspensive
        condition has been fulfilled. The Purchasers pay the costs of transfer and transfer duty.</p>
        <p class="b">7. AGENT</p>
        <p>The Seller shall pay the commission of OMATAKO DUNES REALTY, who introduced the Purchasers, on registration.</p>
        <p class="b">8. WHOLE AGREEMENT</p>
        <p>This document is the whole agreement between the parties. No change to it is valid unless in writing and signed by
        both parties.</p>
        <p style="margin-top:26px">SIGNED by the SELLER at WINDHOEK on 10 April 2014.</p>
        ${sigBlock('SELLER', 'WITNESS', seed)}
        <p style="margin-top:26px">SIGNED by the PURCHASERS at WINDHOEK on 12 April 2014.</p>
        ${sigBlock('PURCHASER (S. HAUFIKU)', 'PURCHASER (F. HAUFIKU)', seed + 20)}`, { pageNo: 'Page 2 of 2' });
    return [p1, p2];
}

/** A Surveyor-General diagram: the figure with its beacons, the sides, and the certificate. */
function sgDiagram({ no, land, beacons, area, surveyed, surveyor, approved, seed, old = false }) {
    const year = yearOf(approved);
    const xs = beacons.map(b => b[1]), ys = beacons.map(b => b[2]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min(380 / (maxX - minX), 300 / (maxY - minY));
    const pt = ([, x, y]) => [60 + (x - minX) * scale, 340 - (y - minY) * scale];
    const poly = beacons.map(b => pt(b).join(',')).join(' ');
    const labels = beacons.map(b => { const [x, y] = pt(b); return `<circle cx="${x}" cy="${y}" r="3.5" fill="#111"/><text x="${x + 7}" y="${y - 7}" font-size="15">${b[0]}</text>`; }).join('');
    const sides = beacons.map((b, i) => {
        const n = beacons[(i + 1) % beacons.length];
        const length = Math.hypot(n[1] - b[1], n[2] - b[2]).toFixed(2).replace('.', ',');
        return `<tr><td>${b[0]} – ${n[0]}</td><td style="text-align:right">${length}</td></tr>`;
    }).join('');
    const names = beacons.map(b => b[0]).join(' ');
    return [page(old ? 'typed' : 'sans', `
        <div class="c" style="font-size:12px;letter-spacing:.1em">${country(year)} · OFFICE OF THE SURVEYOR-GENERAL · WINDHOEK</div>
        <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:13px">
          <div><b>S.G. No. ${no}</b></div><div>Approved: ${signature(seed, 110)}<br>SURVEYOR-GENERAL · ${approved}</div></div>
        <h1 style="font-size:20px;margin-top:6px">DIAGRAM</h1>
        <svg width="636" height="390" style="border:1px solid #333;margin:8px 0 14px">
          <polygon points="${poly}" fill="none" stroke="#111" stroke-width="2"/>${labels}
          <g transform="translate(580,60)"><path d="M0 30 L0 -20 M-8 -8 L0 -22 L8 -8" stroke="#111" stroke-width="1.5" fill="none"/><text x="-5" y="45" font-size="14">N</text></g>
          <g transform="translate(60,372)"><rect width="${10 * scale}" height="6" fill="none" stroke="#111"/><rect width="${5 * scale}" height="6" fill="#111"/>
          <text x="0" y="-4" font-size="10">0</text><text x="${10 * scale - 14}" y="-4" font-size="10">10 m</text></g>
        </svg>
        <div style="display:flex;gap:32px">
          <table><tr><th>Side</th><th>Metres</th></tr>${sides}</table>
          <div style="flex:1;font-size:13px">
            <p>The figure <b>${names}</b> represents <b>${area}</b> of land, being <b>${land.full}</b>, ${situate(year)}.</p>
            <p>Beacons: ${names} (${beacons.length}), iron pegs. Surveyed in ${surveyed} by me,</p>
            <p>${signature(seed + 5, 150)}<br><b>${surveyor}</b></p>
          </div>
        </div>`)];
}

/** The bond registered with the 2014 transfer: the intended poor scan, with a stamp over the text. */
function mortgageBond({ seed }) {
    const { simon, frieda } = PEOPLE;
    return [page('print', `
        <div class="prepared">Prepared by me<br>${signature(seed + 3, 110)}<br>CONVEYANCER<br>M. Gariseb</div>
        ${registered('B 1944/2014', '18 July 2014')}
        <div style="height:70px"></div>${registryHeader(2014)}
        <h1>MORTGAGE BOND</h1><h2>No. B 1944/2014</h2>
        <p class="b c">BE IT HEREBY MADE KNOWN</p>
        <p>THAT <span class="b">MARTHA GARISEB</span> appeared before me, REGISTRAR OF DEEDS at WINDHOEK, being duly authorised by a
        Power of Attorney granted to her by <span class="b">${simon.name}</span> (Identity Number ${simon.id}) and
        <span class="b">${frieda.name}</span>, married to each other in community of property (hereinafter called "the Mortgagor").</p>
        <p>AND THE APPEARER DECLARED that the Mortgagor is truly and lawfully indebted to
        <span class="b">OMARURU BUILDING SOCIETY LIMITED</span> (hereinafter called "the Mortgagee") in the capital sum of
        <span class="b">N$ 1 160 000,00</span> (One Million One Hundred and Sixty Thousand Namibia Dollars), arising from a loan
        advanced, together with interest and costs as set out in the conditions annexed.</p>
        <p>AS SECURITY for the due payment of the said sum, the Appearer, in her capacity aforesaid, declared to bind specially as a
        FIRST MORTGAGE:</p>
        <p class="b">${ERF_2417.full}</p>
        <p>${situate(2014)}; MEASURING ${ERF_2417.extent}; HELD by Deed of Transfer No. T 2876/2014.</p>
        <p>THUS DONE AND EXECUTED at the Office of the REGISTRAR OF DEEDS at WINDHOEK on 18 July 2014.</p>
        ${sigBlock('q.q. Appearer', 'In my presence<br>REGISTRAR OF DEEDS', seed)}`,
        // a reception stamp across the middle, over the text, as so often on old bonds
        { extra: `<div class="stamp" style="color:#8a1f1f;top:560px;left:250px;transform:rotate(-14deg);font-size:15px;padding:10px 18px">
                  DEEDS OFFICE WINDHOEK<br>RECEIVED<br>03 JUL 2014<br>LODGEMENT No. 4471</div>` })];
}

/** The municipality's rates clearance for the estate transfer of Erf 815. */
function ratesClearance({ seed }) {
    return [page('sans', `
        <div style="display:flex;align-items:center;gap:16px;border-bottom:2px solid #1f4e79;padding-bottom:10px">
          <div class="arms" style="margin:0">CITY<br>CREST</div>
          <div><div style="font-size:18px;font-weight:bold;color:#1f4e79">CITY OF WINDHOEK</div>
          <div style="font-size:12px">Department of Finance · Revenue Section · Independence Avenue</div></div></div>
        <h1 style="font-size:18px;margin-top:30px">RATES CLEARANCE CERTIFICATE</h1>
        <p class="c">Certificate No. <b>RC/2021/08841</b></p>
        <table style="width:100%;margin:22px 0">
          <tr><td style="width:38%">Property</td><td><b>${ERF_815.property}</b>, Windhoek</td></tr>
          <tr><td>Registered owner</td><td>Estate Late P. N. Shipanga (Master's Ref. E 2207/2020)</td></tr>
          <tr><td>Purpose</td><td>Transfer of the property to the heirs</td></tr>
          <tr><td>Paid up to</td><td>31 December 2021</td></tr>
          <tr><td>Valid until</td><td>18 November 2021 (90 days)</td></tr>
        </table>
        <p>This is to certify that all rates, taxes, service charges and other amounts due to the City of Windhoek in respect of
        the above property have been paid up to the date shown, as required before transfer of the property may be registered.</p>
        <p>Issued at Windhoek on <b>20 August 2021</b>.</p>
        ${sigBlock('For: STRATEGIC EXECUTIVE: FINANCE', 'Official stamp', seed)}
        <div class="stamp" style="color:#1f4e79;top:640px;right:110px;transform:rotate(6deg)">CITY OF WINDHOEK<br>REVENUE<br>20 AUG 2021</div>`)];
}

// Every document, in the order they are scanned in the demo. `expect` holds the key fields the AI
// should read (as the review screen shows them); `scan` the effects; `purpose` and `note` go into
// README.md.
const DOCUMENTS = [
    {
        file: '01-erf-2417-sg-diagram-A-318-1989.pdf', type: 'Surveyor-General diagram', seed: 11,
        purpose: 'Erf 2417: the survey that defines the parcel and its area (gives the land record its extent).',
        pages: sgDiagram({ no: ERF_2417.sg, land: ERF_2417, area: '1 050 square metres', surveyed: 'June 1989', approved: '3 August 1989',
            surveyor: 'R. J. HOFFMANN, Professional Land Surveyor No. 142', seed: 11, old: true,
            beacons: [['A', 0, 0], ['B', 30, 0], ['C', 30, 35], ['D', 0, 35]] }),
        expect: {
            sgNo: 'A 318/1989',
            property: 'ERF NO. 2417 OLYMPIA',
            regDiv: 'K',
            extent: '1 050 square metres',
            beacons: 'A B C D (4)',
            surveyor: 'R. J. Hoffmann',
            approved: '3 August 1989'
        },
        scan: { rotate: -0.6, age: 0.7 }
    },
    {
        file: '02-erf-2417-deed-of-grant-G-64-1991.pdf', type: 'Deed of grant', seed: 21,
        purpose: 'Erf 2417: the State grants the new erf to the municipality (the first title in the chain).',
        pages: deedOfGrant({ no: 'G 64/1991', date: '18 March 1991', grantee: 'MUNICIPAL COUNCIL OF WINDHOEK', land: ERF_2417, seed: 21 }),
        expect: {
            deedNo: 'G 64/1991',
            regDate: '18 March 1991',
            property: 'ERF NO. 2417 OLYMPIA',
            regDiv: 'K',
            extent: '1 050 (One Thousand and Fifty) Square Metres',
            sgRef: 'A 318/1989',
            grantor: 'Government of the Republic of Namibia',
            tee1: 'Municipal Council of Windhoek'
        },
        scan: { rotate: 0.5, age: 0.8 }
    },
    {
        file: '03-erf-2417-deed-of-transfer-T-3120-1998.pdf', type: 'Deed of transfer', seed: 31,
        purpose: 'Erf 2417: the municipality sells the erf to Andreas Kambonde.',
        pages: deedOfTransfer({ no: 'T 3120/1998', date: '22 October 1998', prepared: 'L. Strauss', conveyancer: 'LOUIS STRAUSS', pronoun: 'he', font: 'typed',
            from: { name: 'MUNICIPAL COUNCIL OF WINDHOEK' }, to: [PEOPLE.kambonde], marital: 'unmarried', sale: '14 August 1998',
            price: 'N$ 85 000,00 (Eighty Five Thousand Namibia Dollars)', land: ERF_2417, prior: 'Deed of Grant No. G 64/1991', seed: 31 }),
        expect: {
            deedNo: 'T 3120/1998',
            regDate: '22 October 1998',
            property: 'ERF NO. 2417 OLYMPIA',
            priorTitle: 'G 64/1991',
            transferor: 'Municipal Council of Windhoek',
            tee1: 'Andreas Kambonde',
            tee1Id: '66030400213',
            marital: 'unmarried',
            price: 'N$ 85 000,00',
            sgRef: 'A 318/1989'
        },
        scan: { rotate: 0.4, age: 0.45 }
    },
    {
        file: '04-erf-2417-deed-of-sale-2014.pdf', type: 'Deed of sale', seed: 41,
        purpose: 'Erf 2417: Andreas Kambonde sells to Simon and Frieda Haufiku. It shows Frieda\'s full ID number, which the reviewer uses to correct document 05.',
        pages: deedOfSale({ seed: 41 }),
        expect: {
            property: 'Erf 2417, Olympia',
            priorTitle: 'T 3120/1998',
            seller1: 'Andreas Kambonde',
            seller1Id: '66030400213',
            buyer1: 'Simon Haufiku',
            buyer1Id: '79022300471',
            buyer2: 'Frieda Haufiku',
            buyer2Id: '81071100562',
            price: 'N$ 1 450 000,00',
            deposit: 'N$ 145 000,00',
            saleDate: '12 April 2014',
            conveyancer: 'Gariseb & Kotze Attorneys',
            agent: 'Omatako Dunes Realty'
        },
        scan: { rotate: -0.3, age: 0.15 }
    },
    {
        file: '05-erf-2417-deed-of-transfer-T-2876-2014.pdf', type: 'Deed of transfer', seed: 51,
        purpose: 'Erf 2417: the transfer to Simon and Frieda Haufiku, ½ share each.',
        note: 'Intended error: Frieda Haufiku\'s ID number is printed with a digit missing (8107110056). Verify flags it (a Namibian ID has 11 digits); the reviewer corrects it to 81071100562 from the deed of sale (04).',
        pages: deedOfTransfer({ no: 'T 2876/2014', date: '18 July 2014', prepared: 'M. Gariseb', conveyancer: 'MARTHA GARISEB', pronoun: 'she',
            from: PEOPLE.kambonde, to: [PEOPLE.simon, { ...PEOPLE.frieda, idShown: '8107110056' }], marital: 'married to each other in community of property',
            share: 'undivided half share each', sale: '12 April 2014', price: 'N$ 1 450 000,00 (One Million Four Hundred and Fifty Thousand Namibia Dollars)',
            land: ERF_2417, prior: 'Deed of Transfer No. T 3120/1998', seed: 51 }),
        expect: {
            deedNo: 'T 2876/2014',
            regDate: '18 July 2014',
            property: 'ERF NO. 2417 OLYMPIA',
            priorTitle: 'T 3120/1998',
            transferor: 'Andreas Kambonde',
            transferorId: '66030400213',
            tee1: 'Simon Haufiku',
            tee1Id: '79022300471',
            tee2: 'Frieda Haufiku',
            tee2Id: '8107110056 → corrected to 81071100562',
            marital: 'married to each other in community of property',
            share: 'undivided half share each',
            price: 'N$ 1 450 000,00'
        },
        scan: { rotate: 0.7, age: 0.2 }
    },
    {
        file: '06-erf-2417-mortgage-bond-B-1944-2014.pdf', type: 'Mortgage bond', seed: 61,
        purpose: 'Erf 2417: the bond the Haufikus registered with the transfer (shows as an encumbrance on the land record).',
        note: 'Intended poor scan: skewed, faint, with a reception stamp over the text. The AI should still read it; lower-confidence fields are for the reviewer to check.',
        pages: mortgageBond({ seed: 61 }),
        expect: {
            bondNo: 'B 1944/2014',
            regDate: '18 July 2014',
            property: 'ERF NO. 2417 OLYMPIA',
            mortgagor: 'Simon Haufiku and Frieda Haufiku',
            mortgagorId: '79022300471',
            mortgagee: 'Omaruru Building Society Limited',
            amount: 'N$ 1 160 000,00',
            priorTitle: 'T 2876/2014'
        },
        scan: { rotate: -2.4, age: 0.35, faint: true }
    },
    {
        file: '07-erf-815-sg-diagram-A-1127-1972.pdf', type: 'Surveyor-General diagram', seed: 71,
        purpose: 'Erf 815: the survey of the parcel (gives the second land record its extent).',
        pages: sgDiagram({ no: ERF_815.sg, land: ERF_815, area: '1 487 square metres', surveyed: 'March 1972', approved: '19 May 1972',
            surveyor: 'H. W. BRANDT, Land Surveyor No. 38', seed: 71, old: true,
            beacons: [['A', 0, 0], ['B', 41, 0], ['C', 41, 31.27], ['D', 20.5, 41.27], ['E', 0, 31.27]] }),
        expect: {
            sgNo: 'A 1127/1972',
            property: 'ERF NO. 815 LUDWIGSDORF',
            regDiv: 'K',
            extent: '1 487 square metres',
            beacons: 'A B C D E (5)',
            surveyor: 'H. W. Brandt',
            approved: '19 May 1972'
        },
        scan: { rotate: 0.8, age: 0.9 }
    },
    {
        file: '08-erf-815-deed-of-transfer-T-1659-1987.pdf', type: 'Deed of transfer', seed: 81,
        purpose: 'Erf 815: Petrus Nangolo Shipanga buys the erf (the first title linked for this parcel).',
        pages: deedOfTransfer({ no: 'T 1659/1987', date: '7 September 1987', prepared: 'J. du Toit', conveyancer: 'JACOBUS DU TOIT', pronoun: 'he', font: 'typed',
            from: PEOPLE.visagie, to: [PEOPLE.shipanga], marital: 'married out of community of property', sale: '2 June 1987',
            price: 'R 62 000,00 (Sixty Two Thousand Rand)', land: ERF_815, prior: 'Deed of Transfer No. T 410/1973', seed: 81 }),
        expect: {
            deedNo: 'T 1659/1987',
            regDate: '7 September 1987',
            property: 'ERF NO. 815 LUDWIGSDORF',
            priorTitle: 'T 410/1973',
            transferor: 'Hendrik Johannes Visagie',
            transferorId: '34081500118',
            tee1: 'Petrus Nangolo Shipanga',
            tee1Id: '51120100385',
            marital: 'married out of community of property',
            price: 'R 62 000,00'
        },
        scan: { rotate: -0.5, age: 0.75 }
    },
    {
        file: '09-erf-815-deed-of-transfer-T-5530-2021-estate.pdf', type: 'Deed of transfer', seed: 91,
        purpose: 'Erf 815: the estate of the late P. N. Shipanga transfers the erf to his two children, ½ share each.',
        pages: deedOfTransfer({ no: 'T 5530/2021', date: '3 November 2021', prepared: 'T. Nakale', conveyancer: 'TANGENI NAKALE', pronoun: 'she',
            from: PEOPLE.shipanga, to: [PEOPLE.helena, PEOPLE.johannes], marital: 'both unmarried', share: 'undivided half share each',
            estate: { executor: 'NDESHI AMUTENYA', master: 'E 2207/2020' }, price: 'N$ 980 000,00 (Nine Hundred and Eighty Thousand Namibia Dollars)',
            land: ERF_815, prior: 'Deed of Transfer No. T 1659/1987', seed: 91 }),
        expect: {
            deedNo: 'T 5530/2021',
            regDate: '3 November 2021',
            property: 'ERF NO. 815 LUDWIGSDORF',
            priorTitle: 'T 1659/1987',
            transferor: 'Estate Late Petrus Nangolo Shipanga',
            transferorId: '51120100385',
            tee1: 'Helena Ndapandula Shipanga',
            tee1Id: '86051400731',
            tee2: 'Johannes Tuhafeni Shipanga',
            tee2Id: '89093000655',
            marital: 'both unmarried',
            share: 'undivided half share each',
            master: 'E 2207/2020',
            executor: 'Ndeshi Amutenya',
            price: 'N$ 980 000,00 (Nine Hundred and Eighty Thousand Namibia Dollars), the value: transferred by inheritance'
        },
        scan: { rotate: 0.3, age: 0.1 }
    },
    {
        file: '10-erf-815-rates-clearance-certificate.pdf', type: 'Other supporting document', seed: 101,
        purpose: 'Erf 815: the municipality\'s rates clearance for the estate transfer (a supporting document filed with the record).',
        pages: ratesClearance({ seed: 101 }),
        expect: {
            docTitle: 'Rates Clearance Certificate',
            date: '20 August 2021',
            property: 'Erf 815, Ludwigsdorf',
            reference: 'RC/2021/08841'
        },
        scan: { rotate: -0.4, age: 0.1 }
    }
];

// ------------------------------------------------------------------------------------ scan effects

/**
 * In the browser: the photographed page on paper, rotated, aged, with grain and soft edges; as a
 * JPEG data URL. Runs inside Chromium (page.evaluate), so it uses only canvas.
 */
function scanEffect({ src, rotate, age, faint, seed }) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const { width: w, height: h } = img;
            const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
            const ctx = canvas.getContext('2d');
            // a copy of random() above: this function runs inside the browser, without this file's scope
            let a = seed >>> 0;
            const rnd = () => {
                a = (a + 0x6D2B79F5) >>> 0;
                let t = Math.imul(a ^ (a >>> 15), 1 | a);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            // the paper: from white to an older, yellowed sheet
            ctx.fillStyle = `rgb(${250 - 14 * age}, ${248 - 22 * age}, ${242 - 40 * age})`;
            ctx.fillRect(0, 0, w, h);
            ctx.save();
            ctx.translate(w / 2, h / 2);
            ctx.rotate(rotate * Math.PI / 180);
            ctx.filter = `blur(${faint ? 0.9 : 0.45}px) contrast(${faint ? 0.62 : 0.92}) brightness(${faint ? 1.12 : 1})`;
            ctx.globalCompositeOperation = 'multiply';
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            ctx.restore();
            // grain and dust
            const data = ctx.getImageData(0, 0, w, h);
            const px = data.data;
            const grain = 10 + 14 * age + (faint ? 10 : 0);
            for (let i = 0; i < px.length; i += 4) {
                const n = (rnd() - 0.5) * grain;
                px[i] += n; px[i + 1] += n; px[i + 2] += n;
            }
            for (let k = 0; k < 120 * (age + 0.3); k++) {
                const i = (Math.floor(rnd() * h) * w + Math.floor(rnd() * w)) * 4;
                px[i] = px[i + 1] = px[i + 2] = 40 + rnd() * 80;
            }
            ctx.putImageData(data, 0, 0);
            // the scanner's shadow along the edges
            const edge = ctx.createLinearGradient(0, 0, w, 0);
            edge.addColorStop(0, 'rgba(0,0,0,0.16)'); edge.addColorStop(0.025, 'rgba(0,0,0,0)');
            edge.addColorStop(0.975, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,0.12)');
            ctx.fillStyle = edge;
            ctx.fillRect(0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = src;
    });
}

// ------------------------------------------------------------------------------------------- output

function readme() {
    const rows = DOCUMENTS.map(d => `| \`${d.file}\` | ${d.type} | ${d.pages.length} | ${d.purpose}${d.note ? ` **${d.note}**` : ''} |`).join('\n');
    const fields = DOCUMENTS.map(d => `### ${d.file}\n\n${Object.entries(d.expect).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')}`).join('\n\n');
    return `# Demo document set (API-716)

Fictitious scanned land documents for the demo: scan them in (Capture), let the AI read them, check them (Verify), file
them, and build a land record for each property. Every name, ID number and reference is invented; each page carries a
small "SPECIMEN · DEMO · FICTITIOUS" mark. The PDFs are images only (no text layer), as real scans are.

Generated by \`node demo/documents/generate.mjs\` (from the repository root; uses the e2e tests' Chromium). Do not edit
the PDFs by hand: change the script and run it again. \`SHA256SUMS\` lets the demo readiness check (API-717) confirm the
set is complete and unchanged.

## The story

**Erf 2417, Olympia (Windhoek)**: surveyed in 1989, granted by the State to the municipality in 1991, sold to Andreas
Kambonde in 1998, and in 2014 sold to Simon and Frieda Haufiku (married in community of property, ½ share each), who
registered a bond over it. Land record: owners Simon and Frieda Haufiku ½ each, extent 1 050 m² (from the SG diagram),
encumbrance B 1944/2014, chain of title G 64/1991 → T 3120/1998 → T 2876/2014.

**Erf 815, Ludwigsdorf (Windhoek)**: surveyed in 1972, bought by Petrus Nangolo Shipanga in 1987; after his death his
estate transferred it to his two children, ½ share each, in 2021. Land record: owners Helena Ndapandula Shipanga and
Johannes Tuhafeni Shipanga ½ each, extent 1 487 m², chain of title T 1659/1987 → T 5530/2021.

## The documents (in scanning order)

| File | Type | Pages | In the demo |
|---|---|---|---|
${rows}

## Suggested demo flow

1. **Capture** (scan operator): upload 01–06 as one batch for Erf 2417, then 07–10 as a second batch.
2. **Verify** (reviewer): go through the AI's reading. In 05, Frieda Haufiku's ID number is flagged: correct it from
   the deed of sale (04). In 06, the poor scan, check the lower-confidence fields. File each document.
   The automatic cross-check reads each document a second time and flags a field where the two readings disagree
   (for example a name read with a letter missing). Compare it with the scan and correct it: the land record's chain
   check refuses a transferor who was not the previous owner, so a misread name shows up there at the latest.
3. **Land record** (records officer): create the record for Erf 2417, link documents 01–06, accept the suggested owners
   and extent, and submit it for review. Do the same for Erf 815 with 07–10.
4. **Review** (another records officer or supervisor): approve; the record is committed and sealed.

Intake refuses a file it has seen before. Before every demo, bring the install to a known starting state, normally a
fresh, empty install: \`../README.md\`, "Before every demo" (it keeps OpenBao and the blockchain node; not
\`docker compose down -v\`). Regenerating gives byte-identical files, which intake would refuse as already seen.

The documents from before independence (March 1990) are headed "South West Africa", and only those from 1992 on name
the Khomas Region, as real documents of their time would.

## Expected key fields

What the AI reads (checked with the real AI on 16 October 2026). It copies values as the document writes them (capitals,
"ERF NO.", the extent with its words); small differences in wording are normal. Expected flags are named in the table
above.

${fields}
`;
}

/**
 * The PDF with its creation and change dates set to one fixed date of the same length (so the file's
 * byte offsets stay valid): a run draws byte-identical files, and SHA256SUMS only changes with them.
 * @param {!Buffer} pdf
 * @return {!Buffer}
 */
function fixedDates(pdf) {
    const text = pdf.toString('latin1').replace(/\/(CreationDate|ModDate) ?\(D:[^)]*\)/g, (all) => all.replace(/D:[^)]*/, (d) => "D:20261016000000+00'00'".padEnd(d.length, ' ').slice(0, d.length)));
    return Buffer.from(text, 'latin1');
}

const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.5625 });
    const draw = await context.newPage();
    const written = [];
    for (const doc of DOCUMENTS) {
        const scans = [];
        for (const [i, html] of doc.pages.entries()) {
            await draw.setContent(html);
            await draw.evaluate(() => document.fonts.ready);
            const png = await draw.screenshot({ type: 'png' });
            scans.push(await draw.evaluate(scanEffect, { src: `data:image/png;base64,${png.toString('base64')}`, ...doc.scan, seed: doc.seed * 100 + i }));
        }
        const pdfPage = await context.newPage();
        await pdfPage.setContent(`<!doctype html><html><head><style>@page { size: A4; margin: 0 } body { margin: 0 }
            img { display: block; width: 210mm; height: 297mm; page-break-after: always } img:last-child { page-break-after: auto }</style></head>
            <body>${scans.map(src => `<img src="${src}">`).join('')}</body></html>`);
        const pdf = fixedDates(await pdfPage.pdf({ format: 'A4', printBackground: true }));
        await pdfPage.close();
        written.push({ file: doc.file, pdf });
        console.log(`${doc.file}  ${doc.pages.length} page(s)  ${(pdf.length / 1024).toFixed(0)} KB`);
    }
    // only once every document is drawn: a failed run leaves the set as it was
    for (const old of readdirSync(DIR).filter(f => f.endsWith('.pdf'))) rmSync(join(DIR, old));
    for (const { file, pdf } of written) writeFileSync(join(DIR, file), pdf);
    writeFileSync(join(DIR, 'SHA256SUMS'), written.map(({ file, pdf }) => `${createHash('sha256').update(pdf).digest('hex')}  ${file}`).join('\n') + '\n');
    writeFileSync(join(DIR, 'README.md'), readme());
} finally {
    await browser.close();
}
