# Shipping domain data files

## `smdg-liner-codes.json` (CB-68)

- **Source:** SMDG Liner Code List (LCL) — `https://smdg.org/documents/smdg-code-lists/smdg-liner-code-list/` (`SMDG-Liner-codes-list-20261028.xlsx`).
- **Version:** `20261028` (`373` liner codes).
- **Downloaded:** `2026-11-19`.
- **Terms of use (`https://smdg.org/legal-notice/`, checked 2026-11-19):** SMDG e.V. permits copying, downloading, and free-of-charge transfer to third parties; **commercial use requires written permission by SMDG e.V.** (`info@smdg.org`).
- **Project note:** Bundled in this repository for development and demo use. **Once we go live, commercial permission from SMDG e.V. must be obtained.**
- **Rebuilding / overriding:**
  - Rebuild from an updated SMDG workbook:
    `node backend/domains/shipping/scripts/build-carrier-list.mjs <SMDG-Liner-codes-list.xlsx> --version <YYYYMMDD> --downloaded <YYYY-MM-DD>`
  - Or point `shipping-records` to a custom file at runtime via `CARRIER_LIST_FILE`.

## `un-locode-ports.json` (CB-63)

- **Source:** UN/LOCODE code list (UNECE), entries with a sea port function (`1`).
- **Release:** `2025-1` (downloaded `2026-11-16` from `github.com/datasets/un-locode`).
- **Rebuilding / overriding:** `node backend/domains/shipping/scripts/build-port-list.mjs <code-list.csv> --release <name>`, or set `PORT_LIST_FILE` on `shipping-records`.
