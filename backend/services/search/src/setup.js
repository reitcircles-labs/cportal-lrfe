import {createServiceTokenSigner, env} from '@lrfe/common';
import {loadCountryPack} from '@lrfe/search-index';
import {createEdrmsClient, createIntakeClient} from './clients.js';
import {createEngine} from './engine.js';
import {SearchService} from './search.service.js';

/**
 * The search service from its settings, for the service (index.js) and the re-index command
 * (reindex.js). Without OPENSEARCH_URL there is no engine: documents are only fetched and logged.
 */
export function createSearchService({events}) {
  const serviceToken = createServiceTokenSigner({
    secret: env('JWT_SECRET'),
    service: 'search',
  });
  // the AI's reading of an upload, read from intake with a search service token
  const intake = createIntakeClient({
    baseUrl: env('INTAKE_URL', 'http://localhost:3504'),
    serviceToken,
  });
  // filed documents, read from edrms with a search service token
  const edrms = createEdrmsClient({
    baseUrl: env('EDRMS_URL', 'http://localhost:3502'),
    serviceToken,
  });
  const url = env('OPENSEARCH_URL', '');
  const engine = url
    ? createEngine({url, loginDir: env('OPENSEARCH_LOGIN_DIR', '')})
    : null;
  // the country's analysers and reference formats (API-801)
  const pack = loadCountryPack(env('SEARCH_COUNTRY_CODE', 'NA'));
  return new SearchService({events, intake, edrms, engine, pack});
}

/** Creates the indexes, trying again while the engine is starting (about a minute at most). */
export async function prepareIndex(
  service,
  logger,
  {tries = 30, waitMs = 2000} = {},
) {
  for (let i = 1; ; i++) {
    try {
      return await service.prepareIndex();
    } catch (err) {
      if (i >= tries) throw err;
      logger.warn(
        {err: err.message},
        'search: the search engine is not ready yet',
      );
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}
