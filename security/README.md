# Penetration tests

Black-box scans of the application (API-814): they attack a throwaway install from the outside, with
what any outsider or API client has (the site, its API and the published API description,
`backend/services/gateway/docs/openapi.yaml`), never the source code. They complement the e2e
tests, which check that each role is refused what it may not do (`api-by-role`).

| Tool | What it does |
|---|---|
| [ZAP](https://www.zaproxy.org) | Passive scan of the web app (headers, cookies, leaks); active scan of the API from its description (injection, XSS, path traversal, …), signed out and signed in |
| [Nuclei](https://github.com/projectdiscovery/nuclei) | Templates for known flaws, exposed files and misconfigurations |
| [Schemathesis](https://schemathesis.io) | Unexpected and malformed input to every API endpoint: server errors, endpoints answering without a sign-in |
| [OSV-Scanner](https://google.github.io/osv-scanner/) | Known vulnerabilities in the npm packages of the lock files |

All are open source and run as containers at fixed versions (`IMAGES` in `scan.mjs`); no AI and no
key is needed.

## When they run

| Where | Level | What |
|---|---|---|
| Every pull request and push to main (`.github/workflows/tests.yml`, job `pentest`) | `pr` | Each scan a few minutes, all at once: ZAP passive scan of the site, ZAP API scan and Schemathesis signed out and as the records officer, Nuclei on the detected technologies, OSV-Scanner |
| Nightly and on demand (Run workflow) | `nightly` | ZAP full scan of the site (spider and AJAX spider), ZAP API scan and Schemathesis signed out and as each main role (registrar, capture, verify, records officer, admin), all Nuclei templates |
| Before each demo release | | API-818 (not yet) |

**Report only for now:** the job lists its findings (high first) in the job summary and keeps the
reports as the artefact `pentest-reports` for 14 days, but does not fail on them. It fails only when
the install or a scanner did not work. To make a high finding fail the job, set
`PENTEST_BLOCKING: '1'` in the job (or pass `--blocking`), once the false positives are sorted out.

## Running it on a computer

From the repository root, with Docker and Node.js (the first run builds the images, several minutes):

```bash
node security/scan.mjs                               # the pr level
node security/scan.mjs --level nightly               # the deep scans (1 to 3 hours)
node security/scan.mjs --roles rec,adm --blocking    # other roles; fail on a high finding
node security/scan.mjs --version 0.1.0-575d568       # images already built, instead of building
```

It prints `tail -f <reports>/run.log` to follow it. The install is the compose project
`lrfe-pentest` (web 4600, gateway 3900, on 127.0.0.1 only; `E2E_WEB_PORT`/`E2E_API_PORT` to change),
removed with its volumes at the end, also after Ctrl-C. It never touches the demo install, the
rehearsal install, the blockchain node or OpenBao: `e2e/stack/start-docker.mjs` refuses any project
name other than `lrfe-e2e…` or `lrfe-pentest…`.

**One run at a time per machine:** the install's project name and the scanners' container names are
fixed, and stopping a run removes every scanner container (`lrfe-scan-…`) on the machine.

The scanners reach the install by its container name on the project's Docker network
(`http://web:8080`), so it also works with rootless Docker, whose containers cannot reach the
computer's own localhost.

## Reading the results

The reports folder (`security/.reports/<time>-<level>/`, ignored by git; the artefact in the pipeline):

| File | What |
|---|---|
| `summary.md` | The verdict, the count per tool and severity, the high and medium findings |
| `findings.json` | Every finding: tool, id, title, severity (high, medium, low, info), where |
| `zap/*.html` | ZAP's own reports, with each alert's evidence and the fix it suggests |
| `nuclei/nuclei.jsonl`, `schemathesis/<who>/junit.xml`, `osv/osv.json` | The other tools' reports |
| `run.log` | The whole run, with each scanner's output; `stack/containers.log` the install's logs |

Severities: ZAP's High, Nuclei's high and critical, a server error (5xx) or an endpoint answering
without its sign-in (Schemathesis), and a vulnerability with a CVSS score of 7 or more (OSV-Scanner)
are **high**.

The signed-in scans send the user's token on every request (ZAP and Schemathesis); the users are the
demo users, signed in with their authenticator code as the e2e tests do. On this install a token
lasts 4 hours instead of 15 minutes (`docker-compose.pentest.yml`), so it does not expire during a scan.

## A finding

1. Read it in the HTML report (ZAP) or the tool's report, and reproduce it by hand on a test install.
2. **A real flaw:** fix it, and add an e2e or unit test that reproduces it, so it stays fixed on every
   pull request without a scanner.
3. **A false positive:** add it to `accepted-findings.json` with its reason, in the same pull request,
   for review. It is then still listed (as accepted) but no longer counts:

```json
[
  {
    "id": "zap-10038-1",
    "where": "^GET http://web:8080/healthz",
    "reason": "The health check returns no HTML; a content security policy does not apply",
    "accepted": "2026-11-01"
  }
]
```

`id` is the finding's id in `findings.json`; `where` (optional) a regular expression on its address.

## Changing the scans

`scan.mjs` holds the levels (`LEVELS`: roles, minutes per scanner, how many at once) and the scanners'
options; `findings.mjs` reads the reports and gives the verdict (unit tests: `node --test security/*.test.mjs`).
A new scanner version: change its image in `IMAGES` and run both levels once.
