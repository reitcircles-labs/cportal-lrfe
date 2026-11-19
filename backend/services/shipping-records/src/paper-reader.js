import {AppError, BadRequestError} from '@lrfe/common';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
]);
const MAX_BYTES = 15 * 1024 * 1024;

const FALLBACK_SAMPLE = {
  reference: 'PAPER-2026-001',
  carrierCode: 'MSC',
  bookingReference: 'BKG-2026-001',
  toOrder: true,
  shipperName: 'Highland Coffee Exporters',
  issuerStreet: 'Havnekaj 12',
  issuerCity: 'Aarhus',
  issuerCountry: 'DK',
  vesselName: 'MV Atlantic Crest',
  voyageNumber: '2611N',
  portOfLoading: 'DKAAR',
  portOfDischarge: 'NLRTM',
  departureDate: '2026-11-20',
  arrivalDate: '2026-11-24',
  containerNumber: 'MSKU7045123',
  isoEquipmentCode: '22G1',
  sealNumber: 'SL220871',
  goods: '640 bags green coffee',
  hsCode: '090111',
  packages: 640,
  packageDescription: 'Bags',
  grossWeightKg: 38040,
  termsAndConditions: "Shipper's load, stow and count.",
  uncertain: ['grossWeightKg', 'portOfDischarge'],
};

const KNOWN_FIELDS = [
  'reference',
  'carrierCode',
  'bookingReference',
  'toOrder',
  'shipperName',
  'shipperId',
  'consigneeName',
  'consigneeId',
  'issuerStreet',
  'issuerCity',
  'issuerCountry',
  'vesselName',
  'voyageNumber',
  'portOfLoading',
  'portOfDischarge',
  'departureDate',
  'arrivalDate',
  'containerNumber',
  'isoEquipmentCode',
  'sealNumber',
  'goods',
  'hsCode',
  'packages',
  'packageDescription',
  'grossWeightKg',
  'termsAndConditions',
];

/**
 * Resolves a port name or UN/LOCODE against the installed port list when available.
 * @param {string} raw
 * @param {?object} ports
 * @return {string}
 */
function resolvePort(raw, ports) {
  if (typeof raw !== 'string') {
    return '';
  }
  const clean = raw.trim();
  if (!clean) {
    return '';
  }
  const upper = clean.toUpperCase();
  if (!ports) {
    return upper.length === 5 ? upper : clean;
  }
  if (ports.get(upper)) {
    return upper;
  }
  const matches = ports.search(clean, 5);
  return matches.length > 0 ? matches[0].code : clean;
}

/**
 * Matches an extracted party name or code to an active organisation id.
 * @param {string} name
 * @param {!Array<{id: string, code: string, name: string}>} orgs
 * @return {string}
 */
function matchOrganisationId(name, orgs) {
  if (typeof name !== 'string' || !name.trim()) {
    return '';
  }
  const needle = name.trim().toLowerCase();
  const exact = orgs.find(
    org =>
      org.name.toLowerCase() === needle ||
      org.code.toLowerCase() === needle ||
      org.id.toLowerCase() === needle,
  );
  if (exact) {
    return exact.id;
  }
  const partial = orgs.find(org => org.name.toLowerCase().includes(needle));
  return partial ? partial.id : '';
}

/**
 * Parses a boolean field from boolean or string values (e.g. "false" -> false).
 * @param {*} value
 * @return {?boolean}
 */
function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase();
    if (clean === 'false' || clean === '0' || clean === 'no') {
      return false;
    }
    if (clean === 'true' || clean === '1' || clean === 'yes') {
      return true;
    }
  }
  return null;
}

/**
 * Normalizes raw extracted JSON into clean B/L draft fields and uncertain flags.
 * @param {object} raw
 * @return {{fields: object, uncertain: !Array<string>, warnings: !Array<string>}}
 */
function normalizeExtracted(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fields = {};
  for (const key of KNOWN_FIELDS) {
    const value = src[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'toOrder') {
      const parsed = parseBoolean(value);
      if (parsed !== null) {
        fields.toOrder = parsed;
      }
    } else if (key === 'packages' || key === 'grossWeightKg') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        fields[key] = parsed;
      }
    } else if (typeof value === 'string') {
      fields[key] = value.trim();
    }
  }
  if (typeof fields.carrierCode === 'string') {
    fields.carrierCode = fields.carrierCode.toUpperCase();
  }
  if (typeof fields.issuerCountry === 'string') {
    fields.issuerCountry = fields.issuerCountry.toUpperCase();
  }
  const allowedKeys = new Set(KNOWN_FIELDS);
  const uncertain = Array.isArray(src.uncertain)
    ? [...new Set(src.uncertain.filter(key => allowedKeys.has(key)))]
    : [];
  const warnings = Array.isArray(src.warnings)
    ? src.warnings.filter(
        warning => typeof warning === 'string' && warning.trim() !== '',
      )
    : [];
  return {fields, uncertain, warnings};
}

/**
 * Mock extractor for development, CI, and tests: parses JSON if embedded in the buffer, else
 * returns realistic sample B/L fields with uncertain fields flagged for review.
 * @param {!Buffer} buffer
 * @return {object}
 */
function mockExtract(buffer) {
  const text = buffer.toString('utf8').trim();
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to sample extraction
    }
  }
  return structuredClone(FALLBACK_SAMPLE);
}

/**
 * Extracts B/L fields from a scanned PDF or image using Gemini structured output when configured.
 * @param {{buffer: !Buffer, mimeType: string, apiKey: string, model: string}} options
 * @return {!Promise<object>}
 */
async function geminiExtract({buffer, mimeType, apiKey, model}) {
  if (!apiKey) {
    throw new AppError(
      503,
      'Automatic reading is not configured on this server yet',
      {code: 'reading-unavailable'},
    );
  }
  try {
    const {GoogleGenAI} = await import('@google/genai');
    const ai = new GoogleGenAI({apiKey});
    const res = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: buffer.toString('base64'),
              },
            },
            {
              text:
                'Extract the bill of lading fields from this document as JSON with keys: ' +
                KNOWN_FIELDS.join(', ') +
                ', and uncertain (array of field keys whose text is unclear, low-confidence, or conflicting across pages). Return JSON only.',
            },
          ],
        },
      ],
      config: {responseMimeType: 'application/json'},
    });
    return JSON.parse(res.text || '{}');
  } catch {
    throw new AppError(
      502,
      'The automatic check could not read this document; please try again or enter the fields manually.',
    );
  }
}

/**
 * Automatic reader for scanned paper B/Ls (CB-57): reads a PDF or image and pre-fills draft
 * fields, matching ports and active organisations, and flagging uncertain values for confirmation.
 * @param {{
 *   provider?: string,
 *   apiKey?: string,
 *   model?: string,
 *   ports?: ?object,
 *   organisations?: ?object,
 * }} [options]
 * @return {{read: function({fileName: string, mimeType: string, contentBase64: string}): !Promise<object>}}
 */
export function createPaperBlReader({
  provider = 'mock',
  apiKey = '',
  model = 'gemini-2.5-flash',
  ports = null,
  organisations = null,
} = {}) {
  const mode =
    typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (mode !== 'mock' && mode !== 'gemini') {
    throw new Error(
      `EXTRACTION_PROVIDER must be mock or gemini (got ${provider})`,
    );
  }
  return {
    /**
     * Reads one uploaded paper B/L file.
     * @param {{fileName: string, mimeType: string, contentBase64: string}} input
     * @return {!Promise<{
     *   fileName: string,
     *   fields: object,
     *   uncertain: !Array<string>,
     *   warnings: !Array<string>,
     *   summary: string,
     * }>}
     */
    async read({fileName, mimeType, contentBase64}) {
      const cleanName = typeof fileName === 'string' ? fileName.trim() : '';
      if (!cleanName) {
        throw new BadRequestError('Give the uploaded file a name');
      }
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        throw new BadRequestError(
          'Unsupported file type: upload a PDF or image (PNG, JPEG, WebP)',
        );
      }
      if (typeof contentBase64 !== 'string' || contentBase64.trim() === '') {
        throw new BadRequestError('The uploaded file is empty');
      }
      const buffer = Buffer.from(contentBase64, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_BYTES) {
        throw new BadRequestError(
          'The file must be non-empty and at most 15 MB',
        );
      }

      const raw =
        mode === 'gemini'
          ? await geminiExtract({buffer, mimeType, apiKey, model})
          : mockExtract(buffer);

      const {fields, uncertain, warnings} = normalizeExtracted(raw);
      if (fields.portOfLoading) {
        fields.portOfLoading = resolvePort(fields.portOfLoading, ports);
      }
      if (fields.portOfDischarge) {
        fields.portOfDischarge = resolvePort(fields.portOfDischarge, ports);
      }

      if (typeof organisations?.activeOrganisations === 'function') {
        try {
          const active = await organisations.activeOrganisations();
          if (!fields.shipperId && fields.shipperName) {
            const id = matchOrganisationId(fields.shipperName, active);
            if (id) {
              fields.shipperId = id;
            } else {
              uncertain.push('shipperId');
              warnings.push(
                `Shipper "${fields.shipperName}" did not match an active organisation; pick it from the list.`,
              );
            }
          }
          if (
            fields.toOrder === false &&
            !fields.consigneeId &&
            fields.consigneeName
          ) {
            const id = matchOrganisationId(fields.consigneeName, active);
            if (id) {
              fields.consigneeId = id;
            } else {
              uncertain.push('consigneeId');
              warnings.push(
                `Consignee "${fields.consigneeName}" did not match an active organisation; pick it from the list.`,
              );
            }
          }
        } catch {
          // best-effort enrichment; never fail extraction if organisation lookup fails
        }
      }

      const uniqueUncertain = [...new Set(uncertain)];
      const fieldCount = Object.keys(fields).length;
      const checkNote =
        uniqueUncertain.length > 0
          ? ` Check ${uniqueUncertain.length} highlighted field${uniqueUncertain.length === 1 ? '' : 's'} before saving.`
          : ' Review all fields and save the draft.';
      return {
        fileName: cleanName,
        fields,
        uncertain: uniqueUncertain,
        warnings,
        summary: `Read ${fieldCount} fields from ${cleanName}.${checkNote}`,
      };
    },
  };
}
