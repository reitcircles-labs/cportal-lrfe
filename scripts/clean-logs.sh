#!/usr/bin/env bash
# Removes the logs of finished runs from the work folder (the log-cleaner agent).
#
# A file is removed only when all of these hold:
#   - its name ends in .log;
#   - nothing has written to it for HOURS hours (default 3);
#   - no running process has it open (fuser), so a run still going on keeps its log;
#   - it lies at most 4 folders deep and outside the data folders below, which hold databases,
#     registers and stored files, never only logs.
# Everything else stays: reports, scripts, notes, data, screenshots.
#
# Usage: scripts/clean-logs.sh [--delete] [--hours N] [--root DIR]
#   Without --delete it only lists what it would remove (a dry run).

set -euo pipefail

ROOT="${HOME}/lrfe-data"
HOURS=3
DELETE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE=1 ;;
    --hours) HOURS="$2"; shift ;;
    --root) ROOT="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! "${HOURS}" =~ ^[0-9]+$ ]] || (( HOURS < 2 )); then
  echo "--hours must be a whole number of at least 2" >&2
  exit 2
fi
if [[ ! -d "${ROOT}" ]]; then
  echo "no such folder: ${ROOT}" >&2
  exit 2
fi

# Folders never searched: databases, the national-size register, search engines, stored files,
# installed packages, screenshots.
PRUNE=(-name 'scale-*' -o -name 'demo-opensearch' -o -name 'opensearch' -o -name 'pg' \
  -o -name 'pgdata' -o -name 'pg-*' -o -name 'files' -o -name 'node_modules' -o -name 'evidence')
# Logs that are records, not run output: kept whatever their age.
KEEP=(-name 'notify.log')

removed=0
kept_open=0
bytes=0
while IFS= read -r -d '' file; do
  if fuser -s "${file}" 2>/dev/null; then
    kept_open=$((kept_open + 1))
    continue
  fi
  size=$(stat -c %s "${file}")
  bytes=$((bytes + size))
  removed=$((removed + 1))
  if (( DELETE )); then
    rm -f -- "${file}"
    echo "removed ${file}"
  else
    echo "would remove ${file}"
  fi
done < <(find "${ROOT}" -maxdepth 4 \( -type d \( "${PRUNE[@]}" \) -prune \) -o \
  \( -type f -name '*.log' ! \( "${KEEP[@]}" \) -mmin +$((HOURS * 60)) -print0 \))

verb=$([[ ${DELETE} -eq 1 ]] && echo "removed" || echo "would remove")
echo "${verb} ${removed} log(s), $((bytes / 1024)) KiB; kept ${kept_open} still open; older than ${HOURS} h under ${ROOT}"
