import { createServiceClient } from './http.js';
import { edrmsConnectors } from './edrms.js';

/**
 *   urls:          { edrms: 'http://localhost:3502' }
 *   serviceToken:  () => string   a fresh bpm service token per call
 */
export function createConnectors({ urls, serviceToken, fetchImpl }) {
    return {
        ...edrmsConnectors(createServiceClient({ baseUrl: urls.edrms, serviceToken, fetchImpl }))
    };
}
