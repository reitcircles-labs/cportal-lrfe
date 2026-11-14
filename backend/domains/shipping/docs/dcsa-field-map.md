# Field map: DCSA eBL 3.0 → the internal B/L model

The shipping pack keeps one internal model of a bill of lading (epic CB-23). This page says how
DCSA's Transport Document (`TransportDocument` in `dcsa/3.0.3/DCSA_EBL-3.0.3.yaml`) maps onto it:
what is kept, under which name, and what is left out and why. Scope: **container B/Ls only**
(decided 2026-11-14).

## The rule

**The internal model uses DCSA's structure and field names.** Every field the model keeps has the
name, nesting, type, length limit, pattern, code list and required/optional status that DCSA 3.0
gives it in `TransportDocument`; the schema file is the reference for each nested field. The tables
below list every top-level field and every nested object, and the exceptions.

Why keep DCSA's names: DCSA is the standard the carriers use, so the DCSA 3.0 converter (CB-26)
stays a near copy, and a field can always be found in DCSA's documentation under the same name.
Other formats (BIMCO, FIATA, later DCSA versions) map onto this model in their own converters.

**In code:** `@lrfe/domain-shipping/bill-of-lading` (`src/bill-of-lading/`): `checkBillOfLading`
lists every problem (DCSA's schema, compiled from the copied specification, plus the rules on this
page), `assertBillOfLading` answers them as one 400 error, and `billOfLadingHash` gives the SHA-256
of the canonical form (schema version and document, keys sorted at every level).

## What the internal model adds (outside DCSA's document)

These live in the B/L record that holds the document (the record service, CB-27), not inside the
DCSA content, so the document stays exactly what DCSA defines and hashes the same way every time.

| Internal field | Meaning |
|---|---|
| `schemaVersion` | The model the document follows: `dcsa-ebl/3.0` (any 3.0.x release). A later DCSA version gets its own value and an upgrade step. |
| `partyOrganisations` | For each party role (`shipper`, `consignee`, `endorsee`, `issuingParty`, `notifyParties[i]`, …) the platform organisation it is, when known (CB-18). DCSA's party data stays as written on the document. |
| Record id, version, times | Kept by the record service like any record (CB-4 contract). |

## Top-level fields

R = required by DCSA. "Kept" = same name and rules as DCSA.

| DCSA field | R | Internal | Note |
|---|---|---|---|
| `transportDocumentReference` | R | kept | The B/L number, unique per carrier. |
| `transportDocumentSubReference` | | kept | |
| `shippingInstructionsReference` | | kept | |
| `transportDocumentStatus` | R | **left out of the document** | The B/L's state is owned by the title engine (L3, CB-29) and stored in its ledger; the DCSA converter fills this field from that state when it writes DCSA. |
| `transportDocumentTypeCode` | R | kept | `BOL` (bill of lading) or `SWB` (sea waybill). Both are stored; only a `BOL` can be negotiable (L3). |
| `isShippedOnBoardType` | R | kept | |
| `freightPaymentTermCode` | | kept | |
| `isElectronic` | R | kept | Always `true` for a B/L created on the platform; kept so a B/L switched to paper (L3) can say so. |
| `isToOrder` | R | kept | `true` = negotiable ("to order"); `false` = straight. DCSA: no endorsee on a to-order B/L means blank endorsed (a question for CB-29). |
| `numberOfCopiesWithCharges`, `numberOfCopiesWithoutCharges`, `numberOfOriginalsWithCharges`, `numberOfOriginalsWithoutCharges` | | kept | Paper-era counts; an electronic B/L has one original. Kept as data for a switch to paper. |
| `displayedNameForPlaceOfReceipt`, `…PortOfLoad`, `…PortOfDischarge`, `…PlaceOfDelivery` | | kept | The names as printed on the document. |
| `shippedOnBoardDate`, `receivedForShipmentDate`, `issueDate` | | kept | |
| `displayedShippedOnBoardReceivedForShipment` | | kept | |
| `termsAndConditions` | R | kept | Up to 50,000 characters. |
| `receiptTypeAtOrigin`, `deliveryTypeAtDestination` | R | kept | `CY`, `SD` or `CFS`. |
| `cargoMovementTypeAtOrigin`, `cargoMovementTypeAtDestination` | R | kept | `FCL` / `LCL`. |
| `serviceContractReference`, `contractQuotationReference` | | kept | |
| `declaredValue`, `declaredValueCurrency` | | kept | |
| `carrierCode`, `carrierCodeListProvider` | R | kept | SMDG or NMFTA code of the carrier. |
| `carrierClauses` | | kept | |
| `numberOfRiderPages` | | kept | |
| `transports` | R | kept | See nested objects. |
| `charges` | | kept | |
| `placeOfIssue` | | kept | |
| `invoicePayableAt` | R | kept | |
| `partyContactDetails` | R | kept | At least one. |
| `documentParties` | R | kept | See nested objects; links to organisations go in `partyOrganisations`. |
| `consignmentItems` | R | kept | At least one. |
| `utilizedTransportEquipments` | R | kept | At least one: the containers. |
| `exportLicense`, `importLicense` | | kept | |
| `references`, `customsReferences` | | kept | |
| `feedbacks` | | **left out** | API messages between carrier and customer ("unsupported property", "changed value"), not part of the B/L. Not in the Issuance API's version of the document either. |

## Nested objects

All kept with DCSA's names and rules. The required fields are the ones the containers-only check
and later layers rely on.

| DCSA object (path) | Required inside it | Note |
|---|---|---|
| `transports` | `plannedDepartureDate`, `plannedArrivalDate`, `portOfLoading`, `portOfDischarge`, `vesselVoyages` (≥1) | Also `placeOfReceipt`, `placeOfDelivery`, `onwardInlandRouting`, pre- and on-carriage. A change of port of discharge is an amendment (L3). |
| `transports.vesselVoyages[]` | `vesselName`, `carrierExportVoyageNumber` | |
| location objects (`placeOfReceipt`, `portOfLoading`, …) | per DCSA | A location name, facility name, address (or address lines), facility code, UN location code or coordinates, as DCSA allows for each place. |
| `documentParties.shipper` | (itself required) | Name, address, identifying codes, tax references, contacts. |
| `documentParties.consignee` | when not to order | Required when `isToOrder` is false (a straight B/L or a sea waybill); never together with an endorsee (DCSA rule). |
| `documentParties.endorsee` | | Only on a to-order B/L: the party title is endorsed to. None on a to-order B/L = blank endorsed. |
| `documentParties.issuingParty` | (itself required) | The carrier (or its agent) that issues. |
| `documentParties.onBehalfOfShipper`, `onBehalfOfConsignee`, `carriersAgentAtDestination`, `notifyParties[]`, `other[]` | | |
| `consignmentItems[]` | `carrierBookingReference`, `descriptionOfGoods`, `HSCodes`, `cargoItems` (≥1) | |
| `consignmentItems[].cargoItems[]` | `equipmentReference`, `cargoGrossWeight`, `outerPackaging` | `equipmentReference` names the container the goods are in. |
| `…cargoItems[].outerPackaging` | per DCSA | Package code, number of packages, dangerous goods, inner packagings. |
| `utilizedTransportEquipments[]` | `equipment`, `isShipperOwned`, `seals` (≥1) | Also reefer settings, shipping marks, references. |
| `utilizedTransportEquipments[].equipment` | `equipmentReference` | The container number (up to 11 characters), with `ISOEquipmentCode` and `tareWeight`. |
| `utilizedTransportEquipments[].seals[]` | `number` | `source`: carrier, shipper, veterinary or customs. |
| `charges[]` | per DCSA | |

**Printed addresses:** on the shipper, consignee, endorsee and notify parties, DCSA says a `displayedAddress`,
when given, is what the document shows instead of `address` or `addressLines`. The model keeps both;
the converter (CB-26) and later the document view must follow that rule.

## Containers only

A B/L in this model is for goods in containers. The model's check (CB-25) refuses a document unless:

- it lists at least one container in `utilizedTransportEquipments` (DCSA already requires this), and
- every cargo item's `equipmentReference` names one of those containers.

Bulk packaging codes (DCSA's `VY`, `VL`, …) stay allowed: they describe bulk goods inside a
container (a liner bag or a tank container), which is still a container B/L.

**Out of scope** (later extensions, each with its own converter):

- Bulk and break-bulk B/Ls carried without containers, including charter-party B/Ls (BIMCO).
- Forwarders' multimodal B/Ls (FIATA FBL).
- The trade-finance documents of ICC's Key Trade Documents and Data Elements (invoices,
  certificates of origin).
- DCSA's Shipping Instructions (the shipper's request before a B/L exists): the same API file,
  but not a document of title.
