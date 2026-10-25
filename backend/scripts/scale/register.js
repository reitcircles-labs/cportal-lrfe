/**
 * The synthetic national register of the load tests (API-769): parcels spread over townships,
 * farms and registration divisions, each with the documents a deeds registry holds for it, in the
 * order they were registered (its chain of title). Every document is built as edrms files it
 * (catalogue, search text, record metadata and seal from the service's own code), as if the whole
 * register had been back-scanned and filed in the months before `asOf`, one parcel file at a time.
 */
import {createHash} from 'node:crypto';
import {
  docType as edrmsDocType,
  formatEdrmsNo,
  instrumentRefOf,
} from '../../services/edrms/src/catalogue.js';
import {EdrmsService} from '../../services/edrms/src/edrms.service.js';
import {sealOf} from '../../services/edrms/src/seal.js';
import {searchTextOf} from '../../services/edrms/src/search.js';
import {storageKey} from '../../services/edrms/src/storage/index.js';
import {DOC_TYPES} from '../../services/intake/src/doc-types.js';
import {
  createRandom,
  madeUpCompany,
  madeUpPerson,
  madeUpWord,
} from './random.js';

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** Field labels as the intake review screen files them, per document type. */
const LABELS = new Map(
  DOC_TYPES.map(t => [t.id, new Map(t.fields.map(f => [f.k, f.label]))]),
);
const OTHER_TITLES = [
  'Power of attorney to pass transfer',
  'Rates clearance certificate',
  'Consent of the local authority',
  'Court order',
];

/** "14 March 2008", as deeds write a date. */
const deedDate = date =>
  `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/** 1214 → "1 214": thousands grouped with a space, as deeds write them. */
const grouped = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Where the parcels are: townships of erven and farms with portions, each in a registration
 * division and a region, handed out one parcel at a time. Some erven are subdivided into portions
 * and some farm names repeat, as in a real register: the near misses matching must tell apart.
 */
class Geography {
  constructor(random, profile) {
    this.random = random;
    this.profile = profile;
    this.townshipNames = new Set();
    this.township = null;
    this.erfNumber = 0;
    this.pendingErven = [];
    this.farmNumber = 0;
    this.farmNames = [];
    this.pendingFarms = [];
  }

  place() {
    return {
      regDiv: this.random.pick(this.profile.regDivs),
      region: `Region ${this.random.int(1, this.profile.regions)}`,
    };
  }

  newTownship() {
    let name = madeUpWord(this.random, 2, 3);
    if (this.townshipNames.size && this.random.chance(0.15)) {
      const base = [...this.townshipNames][
        this.random.int(0, this.townshipNames.size - 1)
      ].replace(/ Extension \d+$/, '');
      name = `${base} Extension ${this.random.int(1, 12)}`;
    }
    if (this.townshipNames.has(name)) name = `${name} ${this.random.int(2, 9)}`;
    this.townshipNames.add(name);
    this.township = {name, size: this.random.int(150, 3000), ...this.place()};
    this.erfNumber = 0;
  }

  nextErf() {
    if (!this.pendingErven.length) {
      if (!this.township || this.erfNumber >= this.township.size) {
        this.newTownship();
      }
      this.erfNumber += 1;
      const {name, regDiv, region} = this.township;
      const erf = {kind: 'erf', number: String(this.erfNumber), township: name};
      this.pendingErven.push({...erf, regDiv, region});
      // a subdivided erf: the remainder and its portions are parcels of their own
      if (this.random.chance(0.04)) {
        for (let p = this.random.int(2, 4); p >= 1; p--) {
          this.pendingErven.push({...erf, portion: String(p), regDiv, region});
        }
      }
    }
    return this.pendingErven.shift();
  }

  nextFarmPortion() {
    if (!this.pendingFarms.length) {
      this.farmNumber += 1;
      let name = madeUpWord(this.random, 2, 3);
      if (this.farmNames.length && this.random.chance(0.1)) {
        name = this.random.pick(this.farmNames);
      } else {
        this.farmNames.push(name);
      }
      const farm = {
        kind: 'farm_portion',
        farmName: name,
        farmNumber: String(this.farmNumber),
        ...this.place(),
      };
      this.pendingFarms.push(farm);
      for (let p = this.random.int(0, 6); p >= 1; p--) {
        this.pendingFarms.push({...farm, portion: String(p)});
      }
    }
    return this.pendingFarms.shift();
  }

  next() {
    return this.random.chance(this.profile.erfShare)
      ? this.nextErf()
      : this.nextFarmPortion();
  }
}

/** The property description a document gives for a parcel, in one of the ways deeds write it. */
function propertyText(random, parcel) {
  if (parcel.kind === 'erf') {
    const of = parcel.portion ? `Portion ${parcel.portion} of ` : '';
    if (random.chance(0.15)) {
      return `${of}ERF NO. ${parcel.number} ${parcel.township.toUpperCase()}`;
    }
    return `${of}Erf ${parcel.number}, ${parcel.township}`;
  }
  const of = parcel.portion ? `Portion ${parcel.portion} of the ` : '';
  return `${of}Farm ${parcel.farmName} No. ${parcel.farmNumber}`;
}

/** The parcel's area as a deed writes it: square metres for an erf, hectares for a farm portion. */
function extentText(random, parcel) {
  if (parcel.kind === 'erf') {
    return `${grouped(random.int(300, 2500))} square metres`;
  }
  const hectares = random.int(100, 8000);
  return `${grouped(hectares)},${random.digits(4)} hectares`;
}

/**
 * Builds the register: `parcels()` yields each parcel with its documents as edrms rows. The same
 * options give the same register.
 */
export class RegisterBuilder {
  /**
   * @param {{seed: number, parcels: number, profile: object, asOf: Date, scanYears: number}} options
   */
  constructor({seed, parcels, profile, asOf, scanYears}) {
    this.random = createRandom(seed);
    this.parcelCount = parcels;
    this.profile = profile;
    this.asOf = asOf;
    this.scanStart = new Date(asOf.getTime() - scanYears * YEAR_MS);
    this.geography = new Geography(this.random, profile);
    this.refCounters = new Map(); // "T/2008" → last number
    this.edrmsCounters = new Map(); // filing year → last sequence number
    this.edrms = new EdrmsService({
      config: {country: profile.country, registry: profile.registry},
    });
    const staff = (role, label) =>
      [1, 2, 3].map(n => ({
        id: `generated-${role}-${n}`,
        name: `Generated ${label} ${n}`,
      }));
    this.scanners = staff('scan', 'scan operator');
    this.reviewers = staff('review', 'reviewer');
    this.banks = Array.from(
      {length: 8},
      () => `${madeUpWord(this.random, 2, 3)} Bank Ltd`,
    );
    this.batchId = null;
  }

  /** The next free reference with this letter and year: "T 2210/2008". */
  reference(letter, year) {
    const key = `${letter}/${year}`;
    const n = (this.refCounters.get(key) ?? 0) + 1;
    this.refCounters.set(key, n);
    return `${letter} ${n}/${year}`;
  }

  /** The last EDRMS sequence number used per filing year: edrms's counter table. */
  counters() {
    return [...this.edrmsCounters].map(([year, last]) => ({year, last}));
  }

  holders() {
    const {random, profile} = this;
    if (random.chance(0.1)) return [madeUpCompany(random)];
    const count = random.chance(0.25) ? 2 : 1;
    return Array.from({length: count}, () =>
      madeUpPerson(random, profile.idDigits),
    );
  }

  /** The chain of a parcel: what was registered for it, oldest first, as [docType, date, fields]. */
  chainOf(parcel) {
    const {random, asOf} = this;
    const chain = [];
    // what every document of this parcel says about it, and where its documents go
    const file = {
      property: propertyText(random, parcel),
      extent: extentText(random, parcel),
      regDiv: parcel.regDiv,
      sgNo: null,
      add: (type, at, fields) => chain.push({type, at, fields}),
    };
    const firstYear =
      parcel.kind === 'erf' ? random.int(1950, 2020) : random.int(1920, 2015);
    let date = new Date(
      Date.UTC(firstYear, random.int(0, 11), random.int(1, 28)),
    );
    if (random.chance(0.92)) this.sgDiagram(file, date);
    let {title, holders} = this.firstTitle(file, date);
    this.maybeBond(file, date, title, holders);

    for (;;) {
      date = this.daysLater(date, 700, 9000);
      if (date.getTime() > asOf.getTime() - 30 * DAY_MS) break;
      if (!random.chance(0.8)) break;
      const buyers = this.holders();
      if (random.chance(0.1)) this.sale(file, date, title, holders, buyers);
      title = this.transfer(file, date, {
        prior: title,
        from: holders,
        to: buyers,
      });
      holders = buyers;
      this.maybeBond(file, date, title, holders);
    }

    if (random.chance(0.06)) {
      const later = this.daysLater(date, 10, 200);
      const at = later < asOf ? later : date;
      file.add('other', at, {
        docTitle: random.pick(OTHER_TITLES),
        date: deedDate(at),
        property: file.property,
        reference: title,
      });
    }
    return chain.sort((a, b) => a.at - b.at);
  }

  /** A date `min` to `max` days after `from` (before it, when negative). */
  daysLater(from, min, max) {
    return new Date(from.getTime() + this.random.int(min, max) * DAY_MS);
  }

  /** The SG diagram the parcel was surveyed on, before its first title. */
  sgDiagram(file, firstTitleDate) {
    const {random} = this;
    const surveyed = this.daysLater(firstTitleDate, -400, -60);
    file.sgNo = this.reference('A', surveyed.getUTCFullYear());
    file.add('sg_diagram', surveyed, {
      sgNo: file.sgNo,
      property: file.property,
      regDiv: file.regDiv,
      extent: file.extent,
      beacons: `A–${'DEFGH'[random.int(0, 4)]}`,
      surveyDate: deedDate(surveyed),
      surveyor: `${madeUpPerson(random, 0).name} (PLS ${random.int(10, 300)})`,
      approved: deedDate(this.daysLater(surveyed, 20, 120)),
    });
  }

  /** The parcel's first title: a grant by the State, or a transfer from a developer. */
  firstTitle(file, date) {
    const holders = this.holders();
    if (!this.random.chance(0.3)) {
      const title = this.transfer(file, date, {
        prior: null,
        from: [madeUpCompany(this.random)],
        to: holders,
      });
      return {title, holders};
    }
    const title = this.reference('G', date.getUTCFullYear());
    file.add('deed_of_grant', date, {
      deedNo: title,
      regDate: deedDate(date),
      property: file.property,
      regDiv: file.regDiv,
      extent: file.extent,
      ...(file.sgNo ? {sgRef: file.sgNo} : {}),
      grantor: 'The State',
      tee1: holders[0].name,
      tee1Id: holders[0].idNo,
    });
    return {title, holders: holders.slice(0, 1)};
  }

  /** The deed of sale signed a month or two before a transfer. */
  sale(file, transferDate, title, sellers, buyers) {
    const signed = this.daysLater(transferDate, -90, -30);
    file.add('deed_of_sale', signed, {
      property: file.property,
      regDiv: file.regDiv,
      extent: file.extent,
      priorTitle: title,
      seller1: sellers[0].name,
      seller1Id: sellers[0].idNo,
      buyer1: buyers[0].name,
      buyer1Id: buyers[0].idNo,
      price: this.amount(50, 9000),
      saleDate: deedDate(signed),
    });
  }

  /** An amount of money between `min` and `max` thousand, as deeds write it: "N$ 640 000,00". */
  amount(min, max) {
    const value = this.random.int(min, max) * 1000;
    return `${this.profile.currency} ${grouped(value)},00`;
  }

  /** A deed of transfer from `from` to `to`; returns its deed number. */
  transfer(file, date, {prior, from, to}) {
    const {property, regDiv, extent, sgNo} = file;
    const {random} = this;
    const deedNo = this.reference('T', date.getUTCFullYear());
    const estate = from.length === 1 && random.chance(0.1);
    const fields = {
      deedNo,
      regDate: deedDate(date),
      property,
      regDiv,
      extent,
      ...(sgNo ? {sgRef: sgNo} : {}),
      ...(prior ? {priorTitle: prior} : {}),
      // several holders sell together: named as one transferor, the buyers take the whole parcel
      transferor: estate
        ? `Estate Late ${from[0].name}`
        : from.map(h => h.name).join(' and '),
      ...(from.length === 1 && !estate ? {transferorId: from[0].idNo} : {}),
    };
    to.forEach((holder, i) => {
      fields[`tee${i + 1}`] = holder.name;
      fields[`tee${i + 1}Id`] = holder.idNo;
    });
    if (to.length === 2) {
      fields.marital = 'married in community of property';
      fields.share = '½ share each';
    }
    fields.price = estate ? 'Inheritance' : this.amount(50, 9000);
    fields.conveyancer = `${madeUpWord(random, 2, 3)} & ${madeUpWord(random, 2, 3)} Attorneys`;
    if (estate) {
      fields.master = this.reference('E', date.getUTCFullYear() - 1);
      fields.executor = madeUpPerson(random, 0).name;
    }
    file.add('deed_of_transfer', date, fields);
    return deedNo;
  }

  /** About half of the titles are financed: a bond registered with the transfer. */
  maybeBond(file, date, title, holders) {
    const {random} = this;
    if (!random.chance(0.45)) return;
    file.add('mortgage_bond', date, {
      bondNo: this.reference('B', date.getUTCFullYear()),
      regDate: deedDate(date),
      property: file.property,
      mortgagor: holders[0].name,
      mortgagorId: holders[0].idNo,
      mortgagee: random.pick(this.banks),
      amount: this.amount(50, 6000),
      priorTitle: title,
    });
  }

  /** One document as edrms files it: the document row and its sealed version 1.0. */
  filed(type, values, filedAt) {
    const {random, profile} = this;
    const labels = LABELS.get(type);
    const fields = Object.entries(values).map(([k, v]) => ({
      k,
      label: labels.get(k) ?? k,
      v,
    }));
    const id = random.uuid();
    const year = filedAt.getUTCFullYear();
    const seq = (this.edrmsCounters.get(year) ?? 0) + 1;
    this.edrmsCounters.set(year, seq);
    const edrmsNo = formatEdrmsNo(profile.country, year, seq);
    const instrumentRef = instrumentRefOf(type, fields);
    const title = edrmsDocType(type).label;
    const capturedBy = random.pick(this.scanners);
    const reviewedBy = random.pick(this.reviewers);
    const recordMetadata = this.edrms.buildRecordMetadata({
      docType: type,
      capturedBy,
      reviewedBy,
    });
    const fileName = `${(instrumentRef ?? type).replace(/[^\w]+/g, '-')}-${random.digits(6)}.pdf`;
    const key = storageKey(id, 1, fileName);
    const version = {
      id: random.uuid(),
      documentId: id,
      versionNumber: 1,
      label: '1.0',
      kind: 'filed',
      reason: null,
      changes: [],
      fields,
      recordMetadata,
      storageKey: key,
      fileName: key.split('/').pop(),
      mimeType: 'application/pdf',
      size: random.int(80_000, 2_500_000),
      // the scan itself is not generated: a stand-in hash, unique per document
      sha256: createHash('sha256').update(`scan:${id}`).digest('hex'),
      createdAt: filedAt,
      createdById: reviewedBy.id,
      createdByName: reviewedBy.name,
    };
    version.seal = sealOf(id, edrmsNo, version);
    const document = {
      id,
      edrmsNo,
      docType: type,
      title,
      instrumentRef,
      registry: profile.registry,
      batchId: this.batchId,
      sourceId: random.uuid(),
      pages: random.int(1, 12),
      fields,
      props: Object.fromEntries(fields.map(f => [f.k, f.v])),
      recordMetadata,
      currentVersion: 1,
      searchText: searchTextOf({title, instrumentRef, edrmsNo, fields}),
      filedAt,
      filedById: reviewedBy.id,
      filedByName: reviewedBy.name,
      updatedAt: filedAt,
    };
    return {document, versions: [version], capturedBy, reviewedBy};
  }

  /**
   * Every parcel with its documents, in filing order: { index, parcel, documents: [{ document,
   * versions }] }. Parcel files are scanned one after the other over the scanning period.
   */
  *parcels() {
    const span = this.asOf.getTime() - this.scanStart.getTime();
    for (let index = 0; index < this.parcelCount; index++) {
      if (index % 50 === 0) this.batchId = this.random.uuid(); // a scanning batch: one box of files
      const parcel = this.geography.next();
      const chain = this.chainOf(parcel);
      const start =
        this.scanStart.getTime() + (index / this.parcelCount) * span;
      const step = span / this.parcelCount / (chain.length + 1);
      const documents = chain.map(({type, fields}, i) =>
        this.filed(type, fields, new Date(Math.round(start + (i + 1) * step))),
      );
      yield {index, parcel, documents};
    }
  }
}
