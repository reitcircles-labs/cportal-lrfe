import { GoogleGenAI, MediaResolution, ThinkingLevel } from '@google/genai';
import { AppError } from '@lrfe/common';
import { buildPrompt, buildResponseSchema } from './prompt.js';

/**
 * A provider reads one document and returns the model's JSON answer:
 *   extract({ buffer, mimeType, fileName }) → { result, usage: { inputTokens, outputTokens, thoughtsTokens }, model, durationMs }
 * `result` follows buildResponseSchema(). Swapping Gemini for another model (LightOnOCR + an
 * extractor, a newer Gemini, Vertex AI) means another provider with the same shape.
 */

export class ExtractionError extends AppError {
    constructor(message, { retryable = true, cause } = {}) {
        super(502, message);
        this.retryable = retryable;
        if (cause) this.cause = cause;
    }
}

const INLINE_LIMIT = 15 * 1024 * 1024;   // Gemini's inline request limit is ~20 MB; base64 adds a third

/**
 * Gemini via @google/genai. Either the Gemini Developer API (apiKey) or Vertex AI
 * (vertex: true, project, location — data stays in the chosen Google Cloud region).
 * Defaults follow Google's document guidance: medium media resolution (560 tokens/page),
 * low thinking (thinking tokens are billed as output).
 */
export function createGeminiProvider({
    model, apiKey, vertex = false, project, location, client,
    transcribe = true, thinkingLevel = 'LOW', mediaResolution = 'MEDIUM'
}) {
    if (!model) throw new Error('Gemini provider: model is required');
    if (!client && !vertex && !apiKey) throw new Error('Gemini provider: GEMINI_API_KEY (or Vertex AI settings) is required');
    const ai = client || new GoogleGenAI(vertex ? { vertexai: true, project, location } : { apiKey });
    const gemini2 = model.startsWith('gemini-2');

    return {
        name: 'gemini',
        model,
        async extract({ buffer, mimeType, fileName }) {
            const t0 = Date.now();
            let uploaded = null;
            try {
                let filePart;
                if (buffer.length <= INLINE_LIMIT) filePart = { inlineData: { mimeType, data: buffer.toString('base64') } };
                else if (vertex) throw new ExtractionError('Files over 15 MB need Cloud Storage input on Vertex AI (not implemented yet)', { retryable: false });
                else {
                    uploaded = await ai.files.upload({ file: new Blob([buffer], { type: mimeType }), config: { mimeType, displayName: fileName } });
                    filePart = { fileData: { fileUri: uploaded.uri, mimeType } };
                }
                const res = await ai.models.generateContent({
                    model,
                    contents: [{ role: 'user', parts: [filePart, { text: buildPrompt({ transcribe }) }] }],
                    config: {
                        responseMimeType: 'application/json',
                        responseJsonSchema: buildResponseSchema(),
                        mediaResolution: MediaResolution[`MEDIA_RESOLUTION_${mediaResolution}`],
                        // Gemini 2.x uses a token budget, Gemini 3 a level
                        thinkingConfig: gemini2 ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel[thinkingLevel] }
                    }
                });
                const u = res.usageMetadata || {};
                const usage = { inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, thoughtsTokens: u.thoughtsTokenCount || 0 };
                let result;
                try {
                    result = JSON.parse(res.text || '');
                } catch {
                    throw new ExtractionError(`${model} did not return valid JSON (finish reason: ${res.candidates?.[0]?.finishReason ?? 'unknown'})`, { retryable: true });
                }
                return { result: sanitize(result), usage, model, durationMs: Date.now() - t0 };
            } catch (err) {
                if (err instanceof ExtractionError) throw err;
                const status = err?.status ?? err?.code;
                // 4xx other than rate limiting will not get better by retrying
                const retryable = !(Number(status) >= 400 && Number(status) < 500 && Number(status) !== 429);
                throw new ExtractionError(`${model} call failed: ${err?.message || err}`, { retryable, cause: err });
            } finally {
                if (uploaded?.name) await ai.files.delete({ name: uploaded.name }).catch(() => {});
            }
        }
    };
}

/** Defensive shape check of the model's JSON (structured output is a strong hint, not a guarantee). */
export function sanitize(r) {
    const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    return {
        docType: str(r?.docType) || 'unknown',
        docTypeReason: str(r?.docTypeReason),
        languages: Array.isArray(r?.languages) ? r.languages.map(str).filter(Boolean) : [],
        handwritingPresent: !!r?.handwritingPresent,
        fields: (Array.isArray(r?.fields) ? r.fields : [])
            .filter(x => x && typeof x.k === 'string')
            .map(x => ({ k: x.k, value: str(x.value), page: Number.isInteger(x.page) ? x.page : null, evidence: str(x.evidence), legible: x.legible !== false })),
        pages: (Array.isArray(r?.pages) ? r.pages : []).filter(p => p && Number.isInteger(p.page)).map(p => ({ page: p.page, text: str(p.text) }))
    };
}

/**
 * Deterministic stand-in (EXTRACTION_PROVIDER=mock, and the tests): no API key, no cost.
 * `respond(file)` returns the answer; the default describes the demo's T 2210/2008.
 */
export function createMockProvider({ model = 'mock-extractor', respond } = {}) {
    return {
        name: 'mock',
        model,
        async extract(file) {
            const result = respond ? await respond(file) : DEMO_ANSWER;
            return { result: sanitize(result), usage: { inputTokens: 1000, outputTokens: 1200, thoughtsTokens: 0 }, model, durationMs: 1 };
        }
    };
}

const DEMO_PAGE = 'DEED OF TRANSFER No. T 2210/2008, registered at the Deeds Registry, Windhoek, on 14 March 2008. ' +
    'BE IT HEREBY MADE KNOWN THAT H. van Wyk, conveyancer, appeared before me, the Registrar of Deeds, duly authorised by power of attorney granted by Johannes Shikongo (Identity No. 61042500187). ' +
    'AND THE APPEARER DECLARED that the transferor had truly and legally sold the property for the sum of N$ 640 000,00, and ceded and transferred it in full and free property to ' +
    'Petrus Nghishidi (Identity No. 72110800345) and Maria Nghishidi (Identity No. 75060200418), married in community of property, in ½ share each: ' +
    'Erf 1873, Klein Windhoek, situated in the Municipality of Windhoek, Registration Division "K", Khomas Region; measuring 1 214 square metres; ' +
    'as will more fully appear from Diagram S.G. No. A 412/2007, and held under Deed of Transfer No. T 1502/1996.';

export const DEMO_ANSWER = {
    docType: 'deed_of_transfer',
    docTypeReason: 'Titled "Deed of Transfer" with a T-series number.',
    languages: ['en'],
    handwritingPresent: false,
    fields: [
        ['deedNo', 'T 2210/2008', 'DEED OF TRANSFER No. T 2210/2008'],
        ['regDate', '14 March 2008', 'Windhoek, on 14 March 2008'],
        ['property', 'Erf 1873, Klein Windhoek', 'Erf 1873, Klein Windhoek, situated'],
        ['regDiv', 'K', 'Registration Division "K"'],
        ['extent', '1 214 square metres', 'measuring 1 214 square metres'],
        ['sgRef', 'A 412/2007', 'Diagram S.G. No. A 412/2007'],
        ['priorTitle', 'T 1502/1996', 'Deed of Transfer No. T 1502/1996'],
        ['transferor', 'Johannes Shikongo', 'granted by Johannes Shikongo'],
        ['transferorId', '61042500187', 'Identity No. 61042500187'],
        ['tee1', 'Petrus Nghishidi', 'to Petrus Nghishidi'],
        ['tee1Id', '72110800345', 'Identity No. 72110800345'],
        ['tee2', 'Maria Nghishidi', 'and Maria Nghishidi'],
        ['tee2Id', '75060200418', 'Identity No. 75060200418'],
        ['marital', 'married in community of property', 'married in community of property'],
        ['share', '½ share each', 'in ½ share each'],
        ['price', 'N$ 640 000,00', 'sum of N$ 640 000,00'],
        ['conveyancer', 'H. van Wyk', 'THAT H. van Wyk, conveyancer']
    ].map(([k, value, evidence]) => ({ k, value, page: 1, evidence, legible: true })),
    pages: [{ page: 1, text: DEMO_PAGE }]
};
