/**
 * A worker thread of the test register's files (API-810): builds the PDFs (documents.js), the
 * slow part, while the main thread writes and encrypts them.
 */
import {parentPort} from 'node:worker_threads';
import {pdfOf} from './documents.js';

parentPort.on('message', async ({id, pages, title, at, scan}) => {
  try {
    // its own memory, so that it can be handed over rather than copied
    const pdf = new Uint8Array(
      await pdfOf(pages, {title, at: new Date(at), scan}),
    );
    parentPort.postMessage({id, pdf}, [pdf.buffer]);
  } catch (err) {
    parentPort.postMessage({id, error: err.message});
  }
});
