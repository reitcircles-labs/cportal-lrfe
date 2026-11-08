# @lrfe/record-contract

The record contract (CB-4): the calls a product's record service answers for the shared services
(audit, extracts, bpm), written once. `land-records` answers it today; the bill-of-lading service
will answer the same calls. The calls, their answers and errors are described in
[`docs/architecture/products.md`](../../../docs/architecture/products.md#the-record-contract-cb-4).

## What it exports

- **`RECORD_CALLS`**: each call by name (`list`, `get`, `versions`, `version`, `lookup`, `seals`,
  `verify`, `commit`, `reject`), with its method and path.
- **`createRecordClient(send)`**: a client of these calls over the caller's own transport.
  `send(method, pathWithQuery, body)` sends one call and answers its JSON; each service keeps its
  own fetch wrapper, timeouts, service token and error texts, and only the paths live here. Query
  entries that are undefined, null or empty are left out, the others kept in the order given.
- **`pathOf(path, params, query)`**: fills `:id` and `:n` and adds the query.
- **`@lrfe/record-contract/contract-suite`**: `describeRecordContract({name, client, fixture})`,
  the contract test (below). A separate export path, so that a service never loads test code.

The address of the record service and its name come from the domain pack
(`recordServiceOf(domain)` in `@lrfe/common`), not from this package.

## The contract test

A mocha suite (it uses mocha's `describe`, `it`, `before`) that calls each call on a record
service and checks the answer's shape, never a product's values: a page of the list, a record with
`current`, 404 for an unknown record or version, the versions list, a version with its data,
lookup, a page of seals and its cursor, verify with `versions[].seal`, `intact` and `linked`, and
commit and reject of a submitted version.

```js
import {describeRecordContract} from '@lrfe/record-contract/contract-suite';

describeRecordContract({
  name: 'land-records',
  client: () => client, // createRecordClient over the test's transport
  fixture: () => fixture, // read in the suite's before hook
});
```

- `client`: answers a client whose calls reject, when the service refuses, with an error whose
  `statusCode` is the answer's status. The transport signs each call as the service that makes it
  (audit for the reading calls, bpm for commit and reject).
- `fixture`: answers (or resolves to) `{recordId, versionNumber, documentId, unknownId, toCommit,
  toReject, by}`: a record with a committed version and a document of it, an id no record has,
  two versions submitted for review (`{recordId, versionNumber}`), and the person who decides
  (not their submitter). The suite commits the first and rejects the second.

land-records runs it in process over `app.inject`:
[`services/land-records/tests/contract.test.js`](../../services/land-records/tests/contract.test.js).

## Tests

```
npm test    # in backend/packages/record-contract
```
