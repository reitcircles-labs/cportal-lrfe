# Sample documents for testers

*Every person, ID number, deed number and parcel detail in these documents is invented. Each page
says so in its footer. Never upload real deeds to a test system.*

The five numbered deeds are the **chain of title of one parcel, Erf 1873, Klein Windhoek**, from the
original grant in 1978 to an inheritance in 2019. A tester takes them from upload, through review,
to an approved land record for Erf 1873. The sixth
is a cover letter, for practising **Reject**.

| File | What it is | Used in |
|---|---|---|
| [01-G-88-1978-deed-of-grant.pdf](01-G-88-1978-deed-of-grant.pdf) | Deed of grant G 88/1978: the State grants the erf to the Municipality of Windhoek | Optional: a different document type to review |
| [02-T-1502-1996-deed-of-transfer.pdf](02-T-1502-1996-deed-of-transfer.pdf) | Deed of transfer T 1502/1996: the Municipality sells to Johannes Shikongo | Optional: file it first, so later deeds find their prior title |
| [03-SG-A-412-2007-diagram.pdf](03-SG-A-412-2007-diagram.pdf) | Surveyor-General diagram A 412/2007: the erf's survey, beacons A–F | Review, file, link into Erf 1873 |
| [04-T-2210-2008-deed-of-transfer.pdf](04-T-2210-2008-deed-of-transfer.pdf) | Deed of transfer T 2210/2008: Shikongo sells to Petrus and Maria Nghishidi | Review, file, link into Erf 1873 |
| [05-T-4521-2019-deed-of-transfer-estate.pdf](05-T-4521-2019-deed-of-transfer-estate.pdf) | Deed of transfer T 4521/2019: Petrus Nghishidi's ½ share is inherited by Ndapewa and Tomas | Review **with a correction**, file, link into Erf 1873 |
| [06-practice-reject-cover-letter.pdf](06-practice-reject-cover-letter.pdf) | A conveyancer's cover letter: not a registry instrument | Practise **Reject** |

## What the AI should read

After upload, the AI reads each document and proposes these values. The reviewer compares each
value with the scan. The AI may word a value slightly differently (for example "1 214 m²" instead of
"1 214 square metres"); that is fine as long as it means the same.

**01 · Deed of grant G 88/1978**

| Field | Value |
|---|---|
| Deed number | G 88/1978 |
| Registration date | 2 May 1978 |
| Property description | Erf 1873, Klein Windhoek |
| Registration division | K |
| Extent | 1 214 square metres |
| Grantor | the State |
| Grantee 1 | Municipality of Windhoek |

**02 · Deed of transfer T 1502/1996**

| Field | Value |
|---|---|
| Deed number | T 1502/1996 |
| Registration date | 19 August 1996 |
| Property description | Erf 1873, Klein Windhoek |
| Registration division | K |
| Extent | 1 214 square metres |
| Prior title | G 88/1978 |
| Transferor | Municipality of Windhoek |
| Transferee 1 | Johannes Shikongo |
| Transferee 1 ID no. | 61042500187 |
| Marital regime | unmarried |
| Consideration | N$ 85 000,00 |

**03 · SG diagram A 412/2007**

| Field | Value |
|---|---|
| Diagram number | A 412/2007 |
| Property description | Erf 1873, Klein Windhoek |
| Registration division | K |
| Area | 1 214 square metres |
| Beacons | A–F (6) |
| Survey date | 22 October 2007 |
| Land surveyor | L. Hamutenya, PLS 0417 |
| Approval date | 30 November 2007 |

**04 · Deed of transfer T 2210/2008**

| Field | Value |
|---|---|
| Deed number | T 2210/2008 |
| Registration date | 14 March 2008 |
| Property description | Erf 1873, Klein Windhoek |
| Registration division | K |
| Extent | 1 214 square metres |
| SG diagram | A 412/2007 |
| Prior title | T 1502/1996 |
| Transferor | Johannes Shikongo |
| Transferor ID no. | 61042500187 |
| Transferee 1 · ID no. | Petrus Nghishidi · 72110800345 |
| Transferee 2 · ID no. | Maria Nghishidi · 75060200418 |
| Marital regime | married in community of property |
| Undivided share | ½ share each |
| Consideration | N$ 640 000,00 |
| Conveyancer | H. van Wyk |

**05 · Deed of transfer T 4521/2019 (estate)**

| Field | Value |
|---|---|
| Deed number | T 4521/2019 |
| Registration date | 9 July 2019 |
| Property description | Erf 1873, Klein Windhoek |
| Registration division | K |
| Extent | 1 214 square metres |
| Prior title | T 2210/2008 |
| Transferor | Estate of the late Petrus Nghishidi |
| Master's reference | E 1830/2018 |
| Executor | D. Amukoto |
| Transferee 1 · ID no. | Ndapewa Nghishidi · 98030100562 |
| Transferee 2 · ID no. | Tomas Nghishidi · **01112500379** (see below) |
| Marital regime | unmarried |
| Undivided share | ¼ share each |
| Consideration | inheritance, no consideration |

> **Watch the marital regime.** The deed says the late Petrus Nghishidi was married in community
> of property, and that the two heirs are both unmarried. The field is about the heirs, so it must
> read **unmarried**. In a check on 3 October 2026, gemini-3.1-flash-lite read "married in community
> of property" in 1 of 6 readings: correct it before filing if it does.
>
> In the same check Gemini always took Tomas Nghishidi's ID number from the margin note
> (01112500379), so the 10-digit warning described below may not appear with the real AI. With the
> canned AI used by the automated tests, sample 05 reads as a copy of T 2210/2008 (see "Things to
> know" below), so the reviewer types its values in.

> **The deliberate mistake.** Tomas Nghishidi's ID number is typed as **0111250379**, with only 10
> digits, and a hand-written note in the margin gives the corrected number **01112500379**. A
> Namibian ID number has 11 digits, so the app flags a 10-digit value. The reviewer must make sure
> the field holds **01112500379** before filing. If they file a wrong number, the Land record screen
> will not let Erf 1873 be submitted for review, because one of its owners would have an invalid ID number.

**06 · Cover letter**: the AI should classify it as **Other supporting document** (or fail to
recognise a type). It is not a registry instrument: the reviewer rejects it with a reason such as
"Cover letter, not a registry instrument".

## Things to know

- **Each deed can be filed once per system.** The EDRMS refuses a second document with the same
  deed number and the review screen flags it as a conflict. On a shared test system, the first
  tester to file a sample "uses it up". Two ways round it:
  - ask the administrator to reset the test system, or
  - make your own set with other numbers:
    `cd e2e && node ../angular-app/docs/samples/generate.mjs --set 2` (then `--set 3`, …). The files
    land in `docs/samples/set-2/`. They describe the same parcel, Erf 1873, which has one land
    record per system: if another tester built it, open it and use **Change record**.
- **The same file cannot be uploaded twice** either: the scan station refuses a file it has seen
  before and says where it already is.
- **Order helps.** Filed in number order (01 → 05), each later deed finds its prior title and SG
  diagram already in the EDRMS, so fewer fields are flagged for checking.
- **On a system with the "canned" AI** (`EXTRACTION_PROVIDER=mock`, used for automated tests), the
  AI does not read the document: every deed reads as T 2210/2008, except that the deed number is
  taken from the file name (`05-T-4521-2019-…` reads as T 4521/2019), and the SG diagram (03) reads as
  diagram A 412/2007. Sample 01 has no T number in its name, so it reads as T 2210/2008 itself: skip
  01 and 02 there. The values above apply to the real AI.
- The PDFs are drawn by `generate.mjs` (in this folder). To change them, edit that file and run it
  again as shown above.
