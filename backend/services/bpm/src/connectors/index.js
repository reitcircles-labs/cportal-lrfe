import {createServiceClient} from './http.js';
import {edrmsConnectors} from './edrms.js';
import {recordsConnectors} from './records.js';

/**
 *   urls:          { edrms: 'http://localhost:3502', records: 'http://localhost:3505' }
 *                  `records` is the product's record service: null when the pack has none,
 *                  and then there are no records connectors.
 *   serviceToken:  () => string   a fresh bpm service token per call
 */
export function createConnectors({urls, serviceToken, fetchImpl}) {
  const connectors = edrmsConnectors(
    createServiceClient({baseUrl: urls.edrms, serviceToken, fetchImpl}),
  );
  if (urls.records === null) {
    return connectors;
  }
  return {
    ...connectors,
    ...recordsConnectors(
      createServiceClient({baseUrl: urls.records, serviceToken, fetchImpl}),
    ),
  };
}
