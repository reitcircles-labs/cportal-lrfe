/** The search text of land records, kept with the record so records are found by it. */

/** Text a record is found by: record number, parcel, owners' names and ID numbers. */
export function searchTextOf(record, ...datas) {
  const parts = [record.recordNo, record.label, record.parcelKey];
  for (const data of datas.filter(Boolean)) {
    for (const o of data.owners || []) parts.push(o.name, o.idNo);
    for (const d of data.documents || []) parts.push(d.ref, d.edrmsNo);
  }
  return parts.filter(Boolean).join(' · ');
}
