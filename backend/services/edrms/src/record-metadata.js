import { BadRequestError } from '@lrfe/common';

/**
 * ISO 23081-aligned record metadata, ported from cportal-be/services/edrms/record-metadata.js.
 * ISO 23081-1 is principles-only (it prescribes categories, not an element list), so these
 * fields are this project's instantiation of its four categories: business/mandate context,
 * agents, relationships, retention/disposition — plus record context and access rights.
 *
 * Validation and self-description live together in FIELD_DEFINITIONS so they cannot drift.
 * Unknown keys are rejected on purpose: land-specific values belong in the document's `fields`.
 */

const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const isoDate = (v) => nonEmpty(v) && !Number.isNaN(Date.parse(v));

export const DISPOSITION_ACTIONS = ['retain', 'review', 'transfer', 'destroy'];
export const AGGREGATION_LEVELS = ['item', 'file', 'series'];

const FIELD_DEFINITIONS = {
    aggregationLevel: { category: 'record', type: 'enum', values: AGGREGATION_LEVELS, description: 'Item, file or series.', validate: (v) => AGGREGATION_LEVELS.includes(v) },
    language: { category: 'record', type: 'string', description: 'Primary language of the record content.', validate: nonEmpty },
    businessFunction: { category: 'business', type: 'string', description: 'Business function that created the record (e.g. "Deeds registration").', validate: nonEmpty },
    businessActivity: { category: 'business', type: 'string', description: 'Activity within that function (e.g. "Registration of transfer").', validate: nonEmpty },
    businessProcess: { category: 'business', type: 'string', description: 'Process that produced this record (e.g. "Back-scanning programme, phase 1").', validate: nonEmpty },
    mandate: {
        category: 'business', type: 'array', itemShape: { reference: 'string', description: 'string?' },
        description: 'Legal or policy authorities under which the record is created and kept.',
        validate: (v) => Array.isArray(v) && v.every(m => m && nonEmpty(m.reference))
    },
    agents: {
        category: 'agent', type: 'array', itemShape: { role: 'string', identifier: 'string', name: 'string?' },
        description: 'People or systems responsible for the record (capturer, reviewer, custodian…).',
        validate: (v) => Array.isArray(v) && v.every(a => a && nonEmpty(a.role) && nonEmpty(a.identifier))
    },
    relationships: {
        category: 'relationship', type: 'array', itemShape: { type: 'string', targetDocumentID: 'string', description: 'string?' },
        description: 'Links to other records (e.g. citesPriorTitle, supports, supersedes).',
        validate: (v) => Array.isArray(v) && v.every(r => r && nonEmpty(r.type) && nonEmpty(r.targetDocumentID))
    },
    retentionSchedule: { category: 'retention', type: 'string', description: 'Retention/disposal authority governing the record.', validate: nonEmpty },
    dispositionAction: { category: 'retention', type: 'enum', values: DISPOSITION_ACTIONS, description: 'Scheduled disposition action.', validate: (v) => DISPOSITION_ACTIONS.includes(v) },
    dispositionDate: { category: 'retention', type: 'date', description: 'When the disposition action is due (ISO 8601).', validate: isoDate },
    legalHold: { category: 'retention', type: 'boolean', description: 'Under legal hold: must not be disposed of.', validate: (v) => typeof v === 'boolean' },
    accessRestriction: { category: 'rights', type: 'string', description: 'Access classification (public, restricted, confidential).', validate: nonEmpty }
};

export const RECORD_METADATA_FIELDS = Object.keys(FIELD_DEFINITIONS);

/** Returns the (possibly partial) object unchanged when valid; `null`/`undefined` → `{}`. */
export function validateRecordMetadata(recordMetadata) {
    if (recordMetadata === undefined || recordMetadata === null) return {};
    if (typeof recordMetadata !== 'object' || Array.isArray(recordMetadata)) throw new BadRequestError('recordMetadata must be an object');
    for (const [key, value] of Object.entries(recordMetadata)) {
        const def = FIELD_DEFINITIONS[key];
        if (!def) throw new BadRequestError(`Unknown record metadata field "${key}". Known fields: ${RECORD_METADATA_FIELDS.join(', ')}`);
        if (value !== null && value !== undefined && !def.validate(value)) throw new BadRequestError(`Invalid value for record metadata field "${key}"`);
    }
    return recordMetadata;
}

/** JSON-safe description of every field (validators stripped, deep-cloned so callers can't mutate definitions). */
export function describeRecordMetadataFields() {
    const out = {};
    for (const [key, { validate, ...rest }] of Object.entries(FIELD_DEFINITIONS)) out[key] = { ...rest, required: false };
    return structuredClone(out);
}
