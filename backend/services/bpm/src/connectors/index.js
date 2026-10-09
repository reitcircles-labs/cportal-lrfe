import { createServiceClient } from './http.js';
import { edrmsConnectors } from './edrms.js';
import { recordsConnectors } from './records.js';

/**
 *   urls:          { edrms: 'http://localhost:3502', records: 'http://localhost:3505' }
 *   serviceToken:  () => string   a fresh bpm service token per call
 */
export function createConnectors({ urls, serviceToken, fetchImpl }) {
    return {
        ...edrmsConnectors(createServiceClient({ baseUrl: urls.edrms, serviceToken, fetchImpl })),
        ...recordsConnectors(createServiceClient({ baseUrl: urls.records, serviceToken, fetchImpl }))
    };
}
