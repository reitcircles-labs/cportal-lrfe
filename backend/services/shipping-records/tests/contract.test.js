import {signServiceToken} from '@lrfe/common';
import {createRecordClient} from '@lrfe/record-contract';
import {describeRecordContract} from '@lrfe/record-contract/contract-suite';

import {by, makeHttp, stores, submittedDraft, users} from './helpers.js';

/** The calls a service other than audit makes: bpm decides a review. */
const CALLER_OF = {commit: 'bpm', reject: 'bpm'};

for (const store of stores()) {
  describe(`the record contract (CB-4), ${store.name}`, () => {
    const ctx = {};

    before(async () => {
      const http = await makeHttp(store);
      const {app} = http;
      ctx.http = http;
      // the transport: app.inject, signed as the service that makes the call
      ctx.client = createRecordClient(async (method, path, body) => {
        const call = Object.keys(CALLER_OF).find(
          name => method === 'POST' && path.endsWith(`/${name}`),
        );
        const res = await app.inject({
          method,
          url: path,
          headers: {
            authorization: `Bearer ${signServiceToken(app, CALLER_OF[call] ?? 'audit')}`,
          },
          payload: body,
        });
        if (res.statusCode >= 400) {
          throw Object.assign(new Error(res.json().message), {
            statusCode: res.statusCode,
          });
        }
        return res.json();
      });

      // a B/L with a committed version: drafted and submitted by one person, approved by another
      const committed = await submittedDraft(http, users.a1, 'CONTRACT0001');
      await http.service.commit(committed, 1, {by: by(users.a2)}, 'bpm');
      ctx.fixture = {
        recordId: committed,
        versionNumber: 1,
        // a B/L version pins no documents
        documentId: null,
        unknownId: '00000000-0000-4000-8000-000000000000',
        toCommit: {
          recordId: await submittedDraft(http, users.a1, 'CONTRACT0002'),
          versionNumber: 1,
        },
        toReject: {
          recordId: await submittedDraft(http, users.a1, 'CONTRACT0003'),
          versionNumber: 1,
        },
        by: by(users.a2),
      };
    });

    after(async () => {
      await ctx.http.close();
    });

    describeRecordContract({
      name: 'shipping-records',
      client: () => ctx.client,
      fixture: () => ctx.fixture,
    });
  });
}
