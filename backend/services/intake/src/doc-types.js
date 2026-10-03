/**
 * The one definition of what we extract from each kind of land-registry instrument. The Gemini
 * prompt, the JSON schema Gemini must answer in, the validators and the review-screen labels are
 * all generated from this list, so they cannot drift apart.
 *
 * Document type ids match the edrms catalogue. Field keys match the frontend's (deedNo,
 * property, tee1Id, …). `type` picks the normaliser/validator in ./extraction/normalize.js:
 *   deed_ref   T 2210/2008, G 88/1978, B 1234/2010      sg_ref    A 412/2007
 *   id_number  Namibian ID, 11 digits                    date      a date as written
 *   extent     1 214 square metres / 12,3456 ha          money     N$ 640 000,00 (or "inheritance")
 *   reg_div    registration division letter              text      anything else
 *
 * `refField` is the field holding the instrument's own reference (unique in the EDRMS).
 */

const f = (k, label, type, desc, required = false) => ({ k, label, type, desc, required });

const PARTY = (prefix, n, role) => [
    f(`${prefix}${n}`, `${role} ${n}`, 'text', `Full name of ${role.toLowerCase()} ${n} as written (person, company, trust or estate)`),
    f(`${prefix}${n}Id`, `${role} ${n} ID no.`, 'id_number', `Namibian identity number (or company registration number) of ${role.toLowerCase()} ${n}, digits exactly as written`)
];

export const DOC_TYPES = [
    {
        id: 'deed_of_transfer', label: 'Deed of transfer', refField: 'deedNo',
        desc: 'Transfers ownership of an erf/farm (sale, inheritance, donation). Reference like "T 2210/2008".',
        fields: [
            f('deedNo', 'Deed number', 'deed_ref', 'Deed of transfer number, e.g. T 2210/2008', true),
            f('regDate', 'Registration date', 'date', 'Date the deed was registered at the Deeds Registry', true),
            f('property', 'Property description', 'text', 'Erf/farm number, portion and township/area, e.g. "Erf 1873, Klein Windhoek"', true),
            f('regDiv', 'Registration division', 'reg_div', 'Registration division letter(s), e.g. K'),
            f('extent', 'Extent', 'extent', 'Area as written, e.g. "1 214 square metres" or hectares'),
            f('sgRef', 'SG diagram', 'sg_ref', 'Surveyor-General diagram number cited, e.g. A 412/2007'),
            f('priorTitle', 'Prior title', 'deed_ref', 'Deed under which the property was previously held, e.g. T 1502/1996'),
            f('transferor', 'Transferor', 'text', 'Party transferring the property (seller, estate, municipality, State)', true),
            f('transferorId', 'Transferor ID no.', 'id_number', 'Identity/registration number of the transferor'),
            ...PARTY('tee', 1, 'Transferee'), ...PARTY('tee', 2, 'Transferee'), ...PARTY('tee', 3, 'Transferee'), ...PARTY('tee', 4, 'Transferee'),
            f('marital', 'Marital regime', 'text', 'Marital regime of the transferee(s) acquiring the property (not of the transferor or a deceased), e.g. "married in community of property", "unmarried"'),
            f('share', 'Undivided share', 'text', 'Share(s) acquired, e.g. "½ share each"'),
            f('price', 'Consideration', 'money', 'Purchase price, or the words used for inheritance/donation'),
            f('conveyancer', 'Conveyancer', 'text', 'Conveyancer who appeared before the Registrar'),
            f('master', "Master's reference", 'deed_ref', "Master of the High Court estate reference, estate transfers only, e.g. E 1830/2018"),
            f('executor', 'Executor', 'text', 'Executor of the estate, estate transfers only')
        ]
    },
    {
        id: 'deed_of_sale', label: 'Deed of sale', refField: null,
        desc: 'Sale agreement (deed of sale / offer to purchase) signed by seller and purchaser before transfer. Not registered, so it has no registry number.',
        fields: [
            f('property', 'Property description', 'text', 'Erf/farm number, portion and township/area sold, e.g. "Portion 3 of the Farm Finkenstein No. 32"', true),
            f('regDiv', 'Registration division', 'reg_div', 'Registration division letter(s), e.g. K'),
            f('extent', 'Extent', 'extent', 'Area as written'),
            f('priorTitle', 'Title deed', 'deed_ref', 'Deed of transfer under which the seller holds the property, e.g. T 1502/1996'),
            ...PARTY('seller', 1, 'Seller'), ...PARTY('seller', 2, 'Seller'),
            f('sellerRep', 'Seller represented by', 'text', 'Person signing for a seller that is a trust, company or close corporation, and in what capacity'),
            ...PARTY('buyer', 1, 'Purchaser'), ...PARTY('buyer', 2, 'Purchaser'),
            f('buyerRep', 'Purchaser represented by', 'text', 'Person signing for a purchaser that is a trust, company or close corporation, and in what capacity'),
            f('price', 'Purchase price', 'money', 'Total purchase price', true),
            f('deposit', 'Deposit', 'money', 'Deposit payable, if any'),
            f('conditions', 'Suspensive conditions', 'text', 'Conditions the sale depends on, e.g. bond approval by a date; short summary in the document\'s words'),
            f('occupation', 'Occupation date', 'text', 'Date or event on which the purchaser takes occupation'),
            f('conveyancer', 'Transferring attorneys', 'text', 'Conveyancers/attorneys appointed to register the transfer'),
            f('agent', 'Estate agent', 'text', 'Estate agency, if any'),
            f('saleDate', 'Date signed', 'date', 'Date of signature (the later of seller and purchaser if both are given)', true),
            f('signedAt', 'Place signed', 'text', 'Place where the agreement was signed')
        ]
    },
    {
        id: 'deed_of_grant', label: 'Deed of grant', refField: 'deedNo',
        desc: 'Original grant of land by the State or a local authority. Reference like "G 88/1978".',
        fields: [
            f('deedNo', 'Deed number', 'deed_ref', 'Deed of grant number, e.g. G 88/1978', true),
            f('regDate', 'Registration date', 'date', 'Date registered', true),
            f('property', 'Property description', 'text', 'Erf/farm and township/area', true),
            f('regDiv', 'Registration division', 'reg_div', 'Registration division letter(s)'),
            f('extent', 'Extent', 'extent', 'Area as written'),
            f('sgRef', 'SG diagram', 'sg_ref', 'Surveyor-General diagram or general plan number'),
            f('grantor', 'Grantor', 'text', 'Granting authority, e.g. the State / Republic of Namibia'),
            ...PARTY('tee', 1, 'Grantee')
        ]
    },
    {
        id: 'sg_diagram', label: 'Surveyor-General diagram', refField: 'sgNo',
        desc: 'Survey diagram approved by the Surveyor-General, with beacons and area. Number like "A 412/2007".',
        fields: [
            f('sgNo', 'Diagram number', 'sg_ref', 'Diagram number, e.g. A 412/2007', true),
            f('property', 'Property description', 'text', 'Erf/farm and township/area shown', true),
            f('regDiv', 'Registration division', 'reg_div', 'Registration division letter(s)'),
            f('extent', 'Area', 'extent', 'Area as written on the diagram', true),
            f('beacons', 'Beacons', 'text', 'Beacon letters and count, e.g. "A–F (6)"'),
            f('surveyDate', 'Survey date', 'date', 'Date of survey'),
            f('surveyor', 'Land surveyor', 'text', 'Professional land surveyor and registration number'),
            f('approved', 'Approval date', 'date', 'Date approved by the Surveyor-General')
        ]
    },
    {
        id: 'mortgage_bond', label: 'Mortgage bond', refField: 'bondNo',
        desc: 'Bond registered over the property in favour of a lender. Reference like "B 1234/2010".',
        fields: [
            f('bondNo', 'Bond number', 'deed_ref', 'Mortgage bond number, e.g. B 1234/2010', true),
            f('regDate', 'Registration date', 'date', 'Date registered', true),
            f('property', 'Property description', 'text', 'Erf/farm and township/area mortgaged', true),
            f('mortgagor', 'Mortgagor', 'text', 'Owner who grants the bond', true),
            f('mortgagorId', 'Mortgagor ID no.', 'id_number', 'Identity/registration number of the mortgagor'),
            f('mortgagee', 'Mortgagee', 'text', 'Lender in whose favour the bond is registered', true),
            f('amount', 'Bond amount', 'money', 'Capital amount of the bond'),
            f('priorTitle', 'Title deed', 'deed_ref', 'Title deed under which the mortgagor holds the property')
        ]
    },
    {
        id: 'other', label: 'Other supporting document', refField: null,
        desc: 'Anything else (power of attorney, consent, court order, certificate…).',
        fields: [
            f('docTitle', 'Document title', 'text', 'Title or heading of the document', true),
            f('date', 'Date', 'date', 'Main date on the document'),
            f('property', 'Property description', 'text', 'Erf/farm referred to, if any'),
            f('reference', 'Reference', 'text', 'Any reference number on the document')
        ]
    }
];

export const DOC_TYPE_IDS = DOC_TYPES.map(t => t.id);
export const docType = (id) => DOC_TYPES.find(t => t.id === id) || null;

/** Every field key across all types (the JSON schema's enum). */
export const ALL_FIELD_KEYS = [...new Set(DOC_TYPES.flatMap(t => t.fields.map(x => x.k)))];
