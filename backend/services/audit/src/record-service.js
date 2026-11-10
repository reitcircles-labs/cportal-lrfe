import {AppError, domain, recordServiceOf} from '@lrfe/common';
import {createRecordClient} from '@lrfe/record-contract';

/** What a call answers when the product has no record service (CB-4). */
export const NO_RECORD_SERVICE = 'This install has no record service';

/**
 * What error texts call the product's record service (`land records` for land), or null when the
 * pack has none.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {?string}
 */
export function recordServiceLabel(pack = domain) {
  return recordServiceOf(pack)?.label ?? null;
}

/**
 * A client of the record contract (`@lrfe/record-contract`) at `recordsUrl`, over the caller's own
 * transport, so that each caller keeps its timeouts and error texts. Without an address (a product
 * with no record service) every call answers 503.
 * @param {?string} recordsUrl
 * @param {function(string, string, (object|undefined)): !Promise<*>} read `read(url, method, body)`
 * @return {!ReturnType<typeof createRecordClient>}
 */
export function recordClientAt(recordsUrl, read) {
  return createRecordClient(async (method, path, body) => {
    if (!recordsUrl) {
      throw new AppError(503, NO_RECORD_SERVICE);
    }
    return read(`${recordsUrl}${path}`, method, body);
  });
}
