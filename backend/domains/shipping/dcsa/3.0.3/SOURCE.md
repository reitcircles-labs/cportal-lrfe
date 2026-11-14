# DCSA eBL 3.0.3: where these files come from

These files are copied unchanged from the Digital Container Shipping Association (DCSA). They are
the reference for the shipping pack's bill-of-lading model (epic CB-23). Do not edit them; a new
DCSA release goes in its own folder next to this one.

| File | DCSA API | Version | Source |
|---|---|---|---|
| `DCSA_EBL-3.0.3.yaml` | Shipping Instructions and Transport Document API (the B/L itself) | 3.0.3 | https://api.swaggerhub.com/apis/dcsaorg/DCSA_EBL/3.0.3/swagger.yaml |
| `DCSA_EBL_ISS-3.0.3.yaml` | eBL Issuance API (a carrier hands an issued B/L to an eBL platform) | 3.0.3 | https://api.swaggerhub.com/apis/dcsaorg/DCSA_EBL_ISS/3.0.3/swagger.yaml |

- **Release:** 3.0.3 is the latest published 3.0 release (last changed by DCSA on 2026-04-13;
  3.0.0 was 2024-12-16). Checked and copied on 2026-11-14 (CB-24).
- **Not copied:** the Surrender API (3.0.3, used by the surrender flow, CB-13) and the Platform
  Interoperability API (PINT), which is still a beta at DCSA (latest 3.0.0-Beta-20261005; used for
  transfers to other platforms, CB-17).
- **Licence:** Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0), as stated in each
  file's `info.license`. Copyright DCSA.
- **The standard behind them:** DCSA Interface Standard for the Bill of Lading 3.0
  (https://dcsa.org/standards/bill-of-lading/) and the DCSA Information Model.

## Examples

`examples/` holds DCSA's own example transport documents, taken from the files above (the
`value` of the named example, unchanged). They are the test set for the model and the converters.

| File | Taken from | Status in the example |
|---|---|---|
| `td-regular.json` | `DCSA_EBL`, GET `/v3/transport-documents/{ref}`, example `regularSTDExample` | DRAFT |
| `td-reefer.json` | same call, example `reeferExample` (a refrigerated container) | APPROVED |
| `td-dangerous-goods.json` | same call, example `dgExample` (dangerous goods) | ISSUED |
| `td-draft-notification.json` | `DCSA_EBL`, POST `/v3/transport-document-notifications`, `draftFullStateTransferExample` → `data.transportDocument` | DRAFT |
| `td-issued-notification.json` | same call, `issuedFullStateTransferExample` → `data.transportDocument` | ISSUED |
| `issuance-regular.json` | `DCSA_EBL_ISS`, PUT `/v3/ebl-issuance-requests`, `regularSTDExample` → `document` | DRAFT |

Each example has one consignment item and one container.

## Checksums (SHA-256)

```
ec096c0ae02a7aef7f51d5249d767c1876c49883f744092e2b492eddcbd18964  DCSA_EBL-3.0.3.yaml
ce72d2be7d83dd1824efb752cb57faa1a902219ec3c103c19560099140e67696  DCSA_EBL_ISS-3.0.3.yaml
8c7c82a57d92ed7874fba0dafbc60497596a0318165d87b4ae5c715b21bfb06b  examples/issuance-regular.json
8f4ade51e82551ff12d70967cb595e2ef5e966be8098d6feddec66f444ff31a4  examples/td-dangerous-goods.json
1ffb25a21298dc5801ea03c8ea1963828b86dc797f45fc63fcca0af1fba9f3fb  examples/td-draft-notification.json
7be7dac161111539ced1c59705fa2f9d4538abd0141b5ba1929625eec5521058  examples/td-issued-notification.json
c4a007489d744c4ef2c6e378f60f3ad59d2075d7306585e0585af0e225a5000c  examples/td-reefer.json
0e2c773c5aae0990aa2254c9fbb4bc9bcaa71e7ba716eab472732a402c8eccaa  examples/td-regular.json
```

Check them with `sha256sum -c` on the block above, from this folder.
