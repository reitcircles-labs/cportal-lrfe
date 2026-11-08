import {signServiceToken} from '@lrfe/common';
import {createRecordClient} from '@lrfe/record-contract';
import {describeRecordContract} from '@lrfe/record-contract/contract-suite';

import {
  actor,
  commitVersion,
  erf1873,
  erf1873Data,
  makeHttp,
  users,
} from './helpers.js';

/** The calls a service other than audit makes: bpm decides a review. */
const CALLER_OF = {commit: 'bpm', reject: 'bpm'};

/**
 * Puts a record's version in review with `data`, as a submission does (the review step without
 * bpm): the contract's commit and reject then decide it.
 */
async function submitVersion({repo, clock}, recordId, versionNumber, data) {
  await repo.updateVersion(recordId, versionNumber, {
    data,
    state: 'in_review',
    submittedAt: clock(),
    submittedById: users.rec.id,
    submittedByName: users.rec.name,
  });
  await repo.updateRecord(recordId, {draftState: 'in_review'});
}

describe('the record contract (CB-4)', () => {
  const ctx = {};

  before(async () => {
    const http = await makeHttp();
    const {app, service} = http;
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

    const committed = await service.createRecord(
      {parcel: erf1873()},
      actor(users.rec),
    );
    const data = erf1873Data();
    await commitVersion(http, committed.id, 1, data);
    const submitted = async number => {
      const parcel = {...erf1873(), number};
      const r = await service.createRecord({parcel}, actor(users.rec));
      await submitVersion(http, r.id, 1, erf1873Data({parcel}));
      return {recordId: r.id, versionNumber: 1};
    };
    ctx.fixture = {
      recordId: committed.id,
      versionNumber: 1,
      documentId: data.documents[0].edrmsDocumentId,
      unknownId: '00000000-0000-4000-8000-000000000000',
      toCommit: await submitted('1874'),
      toReject: await submitted('1875'),
      by: actor(users.sup),
    };
  });

  describeRecordContract({
    name: 'land-records',
    client: () => ctx.client,
    fixture: () => ctx.fixture,
  });
});
