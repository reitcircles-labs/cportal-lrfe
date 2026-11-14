# B/L formats and converters (CB-26)

A bill of lading is stored in **one internal model** (`dcsa-ebl/3.0`, see `dcsa-field-map.md`).
Every format a B/L can arrive in or be written in has a **converter** that maps it onto that model
and back. The stored model never depends on which formats are on: a converter only translates.

## The setting

`LRFE_BL_FORMATS`: the formats on in this install, comma-separated. Not set: `dcsa-3.0`.

| Name | Format | Converter |
|---|---|---|
| `dcsa-3.0` | DCSA eBL 3.0 TransportDocument (any 3.0.x release) | `src/bill-of-lading/formats/dcsa-3.0.js` |

The service reads it at start (`formatsFromSettings`). An unknown name stops the start with a
message naming it and the known formats. A request naming a format that is not on, or unknown, is
answered 400 (`formatNamed`).

## A converter

An object with:

- `name`: its name in the setting, e.g. `bimco-1.0`;
- `label`: its name for people, e.g. `BIMCO eB/L 1.0`;
- `toModel(document)`: the document in its format → `{billOfLading, status}`, a B/L of the model
  (`{schemaVersion, document}`) and the format's own status of it, or null;
- `fromModel(billOfLading, {status})`: a B/L of the model → the document in its format, with the
  status the platform holds for it.

`toModel` never changes what it is given, and its answer must pass `checkBillOfLading`: a format
that carries less than the model needs is refused with the model's own problems, never filled in
with guesses.

## Adding a format

1. Write its converter in `src/bill-of-lading/formats/<name>.js`.
2. Add it to `FORMATS` in `src/bill-of-lading/formats/index.js`.
3. Add its examples and round-trip tests (`tests/formats.test.js` shows DCSA's): each example
   converts into the model and back without loss.

Nothing else changes: the record service, the title engine and the screens work on the model.

A **new DCSA version** that changes the model (say 4.0) is not a converter alone: it gets its own
schema version (`dcsa-ebl/4.0`), its copied specification in `dcsa/<version>/`, and an upgrade
step for stored B/Ls.
