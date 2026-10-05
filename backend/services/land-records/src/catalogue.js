import Ajv from 'ajv';

/**
 * Parcel kinds and the JSON Schema of a record version for each (README.md section 2). A version
 * records its `schemaVersion` (e.g. "erf/1") and is always validated against that schema: a schema
 * change gets a new number, and older versions keep validating against the one they were made with.
 *
 * Two levels: a draft may be incomplete (types are checked, required fields are not); a version
 * submitted for review must be complete.
 */

const text = { type: 'string', maxLength: 500 };
const source = {
    type: 'object', additionalProperties: false, required: ['from'],
    properties: {
        from: { enum: ['document', 'manual'] },
        edrmsNo: text, by: text, reason: { type: 'string', maxLength: 1000 }
    }
};
const owner = {
    type: 'object', additionalProperties: false, required: ['name', 'share'],
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 300 },
        idNo: { type: 'string', maxLength: 40 },
        share: { type: 'string', pattern: '^[1-9][0-9]*/[1-9][0-9]*$' },     // a fraction: 1/1, 1/2, 1/4
        since: text,                                                          // the deed held under
        source
    }
};
const encumbrance = {
    type: 'object', additionalProperties: false, required: ['type', 'ref'],
    properties: { type: { enum: ['bond', 'servitude', 'other'] }, ref: text, inFavourOf: text, note: { type: 'string', maxLength: 1000 } }
};
const pinnedDocument = {
    type: 'object', additionalProperties: false, required: ['edrmsDocumentId', 'edrmsNo', 'version', 'seal', 'docType'],
    properties: {
        edrmsDocumentId: { type: 'string', format: 'uuid' },
        edrmsNo: text,
        version: { type: 'integer', minimum: 1 },
        seal: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        docType: text,
        ref: { type: ['string', 'null'], maxLength: 100 },
        addedBy: text, addedAt: text,
        fields: { type: 'object', additionalProperties: { type: 'string', maxLength: 2000 } }   // snapshot of the verified fields
    }
};
const extent = (units) => ({
    type: 'object', additionalProperties: false, required: ['value', 'unit'],
    properties: { value: { type: 'number', exclusiveMinimum: 0 }, unit: { enum: units }, source }
});

/** One parcel kind: its parcel fields, the core fields it requires, and how its parcel key is built. */
const KINDS = [
    {
        id: 'erf', label: 'Erf', schemaVersion: 'erf/1',
        parcel: { number: text, portion: { type: ['string', 'null'], maxLength: 20 }, township: text, regDiv: text, region: text },
        parcelRequired: ['number', 'township', 'regDiv'],
        extentUnits: ['m2', 'ha'],
        required: ['parcel', 'extent', 'tenure', 'owners'],
        key: (p) => [p.regDiv, p.township, p.number, p.portion]
    },
    {
        id: 'farm_portion', label: 'Farm portion', schemaVersion: 'farm_portion/1',
        parcel: { farmName: text, farmNumber: text, portion: { type: ['string', 'null'], maxLength: 20 }, regDiv: text, region: text },
        parcelRequired: ['farmName', 'farmNumber', 'regDiv'],
        extentUnits: ['ha', 'm2'],
        required: ['parcel', 'extent', 'tenure', 'owners'],
        key: (p) => [p.regDiv, p.farmName, p.farmNumber, p.portion]
    },
    {
        id: 'sectional_unit', label: 'Sectional title unit', schemaVersion: 'sectional_unit/1',
        parcel: { schemeName: text, schemeNumber: text, unit: text, township: text, regDiv: text, region: text, participationQuota: { type: 'number', exclusiveMinimum: 0 } },
        parcelRequired: ['schemeName', 'schemeNumber', 'unit', 'regDiv'],
        extentUnits: ['m2'],
        required: ['parcel', 'tenure', 'owners'],
        key: (p) => [p.regDiv, p.schemeName, p.schemeNumber, p.unit]
    }
];

function schemaOf(kind, complete) {
    return {
        $id: `${kind.schemaVersion}${complete ? '' : '#draft'}`,
        type: 'object', additionalProperties: false,
        required: complete ? ['schemaVersion', ...kind.required] : ['schemaVersion', 'parcel'],
        properties: {
            schemaVersion: { const: kind.schemaVersion },
            parcel: {
                type: 'object', additionalProperties: false,
                required: complete ? ['kind', ...kind.parcelRequired] : ['kind'],
                properties: { kind: { const: kind.id }, ...kind.parcel }
            },
            extent: extent(kind.extentUnits),
            tenure: { enum: ['freehold', 'leasehold', 'other'] },
            owners: { type: 'array', maxItems: 200, items: owner, ...(complete ? { minItems: 1 } : {}) },
            encumbrances: { type: 'array', maxItems: 500, items: encumbrance },
            attributes: { type: 'object' },                                   // free JSON, not used by checks
            documents: { type: 'array', maxItems: 1000, items: pinnedDocument }
        }
    };
}

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const validators = new Map();
for (const k of KINDS) {
    validators.set(`${k.schemaVersion}:draft`, ajv.compile(schemaOf(k, false)));
    validators.set(`${k.schemaVersion}:complete`, ajv.compile(schemaOf(k, true)));
}

export const PARCEL_KINDS = KINDS.map(({ id, label, schemaVersion }) => ({ id, label, schemaVersion }));
export const kindOf = (id) => KINDS.find(k => k.id === id) || null;
export const schemaFor = (schemaVersion, { complete = true } = {}) => {
    const kind = KINDS.find(k => k.schemaVersion === schemaVersion);
    return kind ? schemaOf(kind, complete) : null;
};

/**
 * Validate a version's data against its own schemaVersion. `complete`: also require the core
 * fields (for review). Returns a list of problems, each "path: message"; empty when valid.
 */
export function validateVersion(data, { complete = false } = {}) {
    const validate = validators.get(`${data?.schemaVersion}:${complete ? 'complete' : 'draft'}`);
    if (!validate) return [`schemaVersion: unknown "${data?.schemaVersion}" (known: ${KINDS.map(k => k.schemaVersion).join(', ')})`];
    if (validate(data)) return [];
    return validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}

/** "erf:K:KLEIN WINDHOEK:1873": one record per parcel. */
export function parcelKey(parcel) {
    const kind = kindOf(parcel?.kind);
    if (!kind) return null;
    const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    const parts = kind.key(parcel).map(norm);
    while (parts.length && !parts[parts.length - 1]) parts.pop();          // no trailing empty portion
    return [kind.id, ...parts].join(':');
}

/** "Erf 1873, Klein Windhoek" — how screens and lists name the parcel. */
export function parcelLabel(parcel) {
    if (!parcel) return '';
    if (parcel.kind === 'erf') return `Erf ${parcel.number}${parcel.portion ? ` portion ${parcel.portion}` : ''}, ${parcel.township}`;
    if (parcel.kind === 'farm_portion') return `${parcel.portion ? `Portion ${parcel.portion} of the ` : ''}Farm ${parcel.farmName} No. ${parcel.farmNumber}`;
    if (parcel.kind === 'sectional_unit') return `Unit ${parcel.unit}, ${parcel.schemeName} (SS ${parcel.schemeNumber})`;
    return '';
}

/** LR-NA-2026-000001 */
export const formatRecordNo = (country, year, seq) => `LR-${country}-${year}-${String(seq).padStart(6, '0')}`;
