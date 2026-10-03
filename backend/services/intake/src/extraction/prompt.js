import { ALL_FIELD_KEYS, DOC_TYPES, DOC_TYPE_IDS } from '../doc-types.js';

/** Bump whenever the prompt or schema changes; stored with every extraction for traceability. */
export const PROMPT_VERSION = 'lr-extract-2026-10-03.1';   // marital regime: whose (API-621); 09-29.2: deed of sale

/** The instruction sent with each document. Generated from doc-types.js. */
export function buildPrompt({ transcribe = true } = {}) {
    const types = DOC_TYPES.map(t => [
        `### ${t.id} — ${t.label}`,
        t.desc,
        ...t.fields.map(x => `- ${x.k}${x.required ? ' (required)' : ''}: ${x.desc}`)
    ].join('\n')).join('\n\n');

    return `You read scanned instruments from the Deeds Registry of the Republic of Namibia (deeds of transfer, deeds of sale, deeds of grant, Surveyor-General diagrams, mortgage bonds and supporting documents) and return their metadata as JSON.

The documents may be old, faded, partly handwritten, or hand-corrected, and may be in English, Afrikaans or German.

Rules:
1. Classify the whole document as exactly one docType. Use "unknown" only if it is not a land-registry instrument or is unreadable.
2. Extract only the fields listed for that docType. Omit a field that is not present — never guess or infer a value.
3. Copy each value exactly as written: keep the original spelling, language, punctuation and digits. Do not translate, correct, reformat or complete anything. If an ID number looks too short or too long, copy it anyway.
4. Where a value was corrected by hand on the document, give the corrected (final) value.
5. "page" is the 1-based page number where the value appears. "evidence" is a short verbatim quote (a few words) from that page that contains the value.
6. Set "legible" to false if you are unsure of any character of the value.
7. Parties are numbered in the order they appear (tee1, tee2, …).
${transcribe ? '8. In "pages", transcribe every page completely in reading order as plain text, one entry per page.' : '8. Return "pages" as an empty list.'}

Document types and their fields:

${types}`;
}

/** JSON schema for the answer (the subset Gemini's structured output supports). */
export function buildResponseSchema() {
    return {
        type: 'object',
        properties: {
            docType: { type: 'string', enum: [...DOC_TYPE_IDS, 'unknown'] },
            docTypeReason: { type: 'string', description: 'One sentence: why this document type' },
            languages: { type: 'array', items: { type: 'string' }, description: 'ISO 639-1 codes of the languages used, e.g. ["en"] or ["af", "en"]' },
            handwritingPresent: { type: 'boolean' },
            fields: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        k: { type: 'string', enum: ALL_FIELD_KEYS },
                        value: { type: 'string' },
                        page: { type: 'integer', minimum: 1 },
                        evidence: { type: 'string' },
                        legible: { type: 'boolean' }
                    },
                    required: ['k', 'value', 'page', 'evidence', 'legible']
                }
            },
            pages: {
                type: 'array',
                items: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, text: { type: 'string' } }, required: ['page', 'text'] }
            }
        },
        required: ['docType', 'languages', 'handwritingPresent', 'fields', 'pages']
    };
}
