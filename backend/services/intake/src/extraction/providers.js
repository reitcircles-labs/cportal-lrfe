import {GoogleGenAI, MediaResolution, ThinkingLevel} from '@google/genai';
import {AppError, domain} from '@lrfe/common';
import {buildPrompt, buildResponseSchema} from './prompt.js';

/**
 * A provider reads one document and returns the model's JSON answer:
 *   extract({ buffer, mimeType, fileName }) → { result, usage: { inputTokens, outputTokens, thoughtsTokens }, model, durationMs }
 * `result` follows buildResponseSchema(). Swapping Gemini for another model (LightOnOCR + an
 * extractor, a newer Gemini, Vertex AI) means another provider with the same shape.
 */

/** A document could not be read by the model (status 502, bad gateway). */
export class ExtractionError extends AppError {
  /** `publicMessage`: what the screens may show (no model or provider names); see readingError(). */
  constructor(message, {retryable = true, cause, publicMessage} = {}) {
    super(502, message);
    this.retryable = retryable;
    if (cause) this.cause = cause;
    if (publicMessage) this.publicMessage = publicMessage;
  }
}

const INLINE_LIMIT = 15 * 1024 * 1024; // Gemini's inline request limit is ~20 MB; base64 adds a third

/**
 * Gemini via @google/genai. Either the Gemini Developer API (apiKey) or Vertex AI
 * (vertex: true, project, location — data stays in the chosen Google Cloud region).
 * Defaults follow Google's document guidance: medium media resolution (560 tokens/page),
 * low thinking (thinking tokens are billed as output).
 */
export function createGeminiProvider({
  model,
  apiKey,
  vertex = false,
  project,
  location,
  client,
  transcribe = true,
  thinkingLevel = 'LOW',
  mediaResolution = 'MEDIUM',
  pack = domain,
}) {
  if (!model) throw new Error('Gemini provider: model is required');
  if (!client && !vertex && !apiKey) {
    throw new Error(
      'Gemini provider: GEMINI_API_KEY (or Vertex AI settings) is required',
    );
  }
  const ai =
    client ||
    new GoogleGenAI(vertex ? {vertexai: true, project, location} : {apiKey});
  const gemini2 = model.startsWith('gemini-2');

  return {
    name: 'gemini',
    model,
    async extract({buffer, mimeType, fileName}) {
      const t0 = Date.now();
      let uploaded = null;
      try {
        let filePart;
        if (buffer.length <= INLINE_LIMIT) {
          filePart = {inlineData: {mimeType, data: buffer.toString('base64')}};
        } else if (vertex) {
          throw new ExtractionError(
            'Files over 15 MB need Cloud Storage input on Vertex AI (not implemented yet)',
            {
              retryable: false,
              publicMessage:
                'The file is too large to be read automatically (over 15 MB)',
            },
          );
        } else {
          uploaded = await ai.files.upload({
            file: new Blob([buffer], {type: mimeType}),
            config: {mimeType, displayName: fileName},
          });
          filePart = {fileData: {fileUri: uploaded.uri, mimeType}};
        }
        const res = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [filePart, {text: buildPrompt({transcribe}, pack)}],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: buildResponseSchema(pack),
            mediaResolution:
              MediaResolution[`MEDIA_RESOLUTION_${mediaResolution}`],
            // Gemini 2.x uses a token budget, Gemini 3 a level
            thinkingConfig: gemini2
              ? {thinkingBudget: 0}
              : {thinkingLevel: ThinkingLevel[thinkingLevel]},
          },
        });
        const u = res.usageMetadata || {};
        const usage = {
          inputTokens: u.promptTokenCount || 0,
          outputTokens: u.candidatesTokenCount || 0,
          thoughtsTokens: u.thoughtsTokenCount || 0,
        };
        let result;
        try {
          result = JSON.parse(res.text || '');
        } catch {
          throw new ExtractionError(
            `${model} did not return valid JSON (finish reason: ${res.candidates?.[0]?.finishReason ?? 'unknown'})`,
            {retryable: true},
          );
        }
        return {
          result: sanitize(result),
          usage,
          model,
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        if (err instanceof ExtractionError) throw err;
        const status = err?.status ?? err?.code;
        // 4xx other than rate limiting will not get better by retrying
        const retryable = !(
          Number(status) >= 400 &&
          Number(status) < 500 &&
          Number(status) !== 429
        );
        throw new ExtractionError(
          `${model} call failed: ${err?.message || err}`,
          {retryable, cause: err},
        );
      } finally {
        if (uploaded?.name) {
          await ai.files.delete({name: uploaded.name}).catch(() => {});
        }
      }
    },
  };
}

/** Defensive shape check of the model's JSON (structured output is a strong hint, not a guarantee). */
export function sanitize(r) {
  const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
  return {
    docType: str(r?.docType) || 'unknown',
    docTypeReason: str(r?.docTypeReason),
    languages: Array.isArray(r?.languages)
      ? r.languages.map(str).filter(Boolean)
      : [],
    handwritingPresent: !!r?.handwritingPresent,
    fields: (Array.isArray(r?.fields) ? r.fields : [])
      .filter(x => x && typeof x.k === 'string')
      .map(x => ({
        k: x.k,
        value: str(x.value),
        page: Number.isInteger(x.page) ? x.page : null,
        evidence: str(x.evidence),
        legible: x.legible !== false,
      })),
    pages: (Array.isArray(r?.pages) ? r.pages : [])
      .filter(p => p && Number.isInteger(p.page))
      .map(p => ({page: p.page, text: str(p.text)})),
  };
}

/**
 * Deterministic stand-in (EXTRACTION_PROVIDER=mock, and the tests): no API key, no cost.
 * `respond(file)` returns the answer; the default is mockAnswer(file).
 */
export function createMockProvider({
  model = 'mock-extractor',
  respond,
  pack = domain,
} = {}) {
  return {
    name: 'mock',
    model,
    async extract(file) {
      const result = respond ? await respond(file) : mockAnswer(file, pack);
      return {
        result: sanitize(result),
        usage: {inputTokens: 1000, outputTokens: 1200, thoughtsTokens: 0},
        model,
        durationMs: 1,
      };
    },
  };
}

/** The answer of a document the stand-in reader does not know: no type, no fields. */
const UNKNOWN_ANSWER = {
  docType: 'unknown',
  docTypeReason: '',
  languages: [],
  handwritingPresent: false,
  fields: [],
  pages: [],
};

/**
 * The stand-in reader's answer for a file: the product's demo reading (`documents.demo` of the
 * domain pack, CB-3), or a document of no known type when the pack has none.
 * @param {{fileName?: string}} file
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {object}
 */
export function mockAnswer(file, pack = domain) {
  const demo = pack.documents.demo;
  return demo ? demo.reading(file) : UNKNOWN_ANSWER;
}
