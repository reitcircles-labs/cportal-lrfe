/**
 * Land records prepared through the API, so a test can start from an approved record: created from
 * a filed deed, completed from it, submitted by the records officer and approved by the registrar.
 */
import {expect, type PlaywrightWorkerArgs} from '@playwright/test';
import {userByRole} from './catalogue';
import {apiAs} from './intake';

/** A land record as the land-records service returns it (the fields the tests read). */
export interface RecordNow {
  id: string;
  recordNo: string;
  currentVersion: number | null;
  draftVersion: number | null;
  newDocuments: number;
}

/** The record as it is now, read as the records officer. */
export async function recordNow(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
  id: string,
): Promise<RecordNow> {
  const r = await apiAs(playwright, baseURL, userByRole('rec').email);
  const now = await (
    await r.api.get(`/api/records/${id}`, {headers: r.headers})
  ).json();
  await r.dispose();
  return now;
}

/**
 * An approved (committed) record for `parcel`, from the filed deed `ref`: its owners and extent
 * taken from the deed, tenure freehold, submitted and approved through the registrar's task.
 */
export async function committedRecord(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
  ref: string,
  parcel: Record<string, string>,
): Promise<RecordNow> {
  const rec = await apiAs(playwright, baseURL, userByRole('rec').email);
  const h = {headers: rec.headers};
  const found = await (
    await rec.api.get(
      `/api/records/document-search?q=${encodeURIComponent(ref)}`,
      h,
    )
  ).json();
  const deed = found.items.find((d: {ref: string}) => d.ref === ref);
  expect(deed, `${ref} in the document search`).toBeTruthy();
  const created = await rec.api.post('/api/records', {
    ...h,
    data: {parcel, edrmsDocumentId: deed.edrmsDocumentId},
  });
  expect(created.status(), await created.text()).toBe(201);
  let record = await created.json();
  const edit = async (data: Record<string, unknown>) => {
    const res = await rec.api.patch(`/api/records/${record.id}/draft`, {
      ...h,
      data: {revision: record.draft.revision, ...data},
    });
    expect(res.status(), await res.text()).toBe(200);
    record = await res.json();
  };
  await edit({accept: ['owners', 'extent']});
  await edit({changes: {tenure: 'freehold'}});
  const submitted = await rec.api.post(
    `/api/records/${record.id}/draft/submit`,
    {...h, data: {revision: record.draft.revision}},
  );
  expect(submitted.status(), await submitted.text()).toBe(200);
  await rec.dispose();

  const reg = await apiAs(playwright, baseURL, userByRole('sup').email);
  let task: {id: string} | undefined;
  await expect
    .poll(
      async () => {
        const {tasks} = await (
          await reg.api.get('/api/tasks', {headers: reg.headers})
        ).json();
        task = tasks.find(
          (t: {title?: string; businessKey?: string}) =>
            t.businessKey === record.id ||
            (t.title ?? '').includes(record.recordNo),
        );
        return !!task;
      },
      {timeout: 20_000},
    )
    .toBe(true);
  const approved = await reg.api.post(`/api/tasks/${task!.id}/complete`, {
    headers: reg.headers,
    data: {output: {outcome: 'approved'}},
  });
  expect(approved.status(), await approved.text()).toBe(200);
  await reg.dispose();
  await expect
    .poll(
      async () =>
        (await recordNow(playwright, baseURL, record.id)).currentVersion,
      {timeout: 20_000},
    )
    .toBe(1);
  return recordNow(playwright, baseURL, record.id);
}
