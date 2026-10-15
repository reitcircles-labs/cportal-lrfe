#!/bin/sh
# Writes the organisation's settings for the web app (API-712), each time the web container starts:
# nginx's entrypoint runs the scripts in /docker-entrypoint.d/ before nginx itself, and nginx serves
# the file as /config.json (docker/nginx.conf). The values come from the site's .env through
# deploy/docker-compose.yml:
#
#   LRFE_ORG_NAME       e.g. Deeds Registry
#   LRFE_ORG_SUBTITLE   shown under the name, e.g. Republic of Namibia
#   LRFE_ORG_PARENT     the body it belongs to, on the sign-in page, e.g. a ministry
#   LRFE_ORG_PLACE      where it is, e.g. Windhoek
#
# Only settings that are set are written: the app uses its defaults for the others
# (angular-app/src/app/state/site-config.ts). An empty setting is written empty, and is not shown.
# Display texts only, readable by anyone who opens the portal: never put a secret here.
set -eu

out=${SITE_CONFIG_FILE:-/tmp/lrfe/config.json}

# A JSON string: control characters (tabs, line breaks) become spaces; backslashes and double
# quotes are escaped
json_string() {
    printf '"%s"' "$(printf '%s' "$1" | tr '\000-\037' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

entries=''
# add <key> <"set" when the setting is set, even if empty> <its value>
add() {
    [ "$2" = set ] || return 0
    entries="$entries${entries:+,}
  \"$1\": $(json_string "$3")"
}
add orgName "${LRFE_ORG_NAME+set}" "${LRFE_ORG_NAME-}"
add orgSubtitle "${LRFE_ORG_SUBTITLE+set}" "${LRFE_ORG_SUBTITLE-}"
add orgParent "${LRFE_ORG_PARENT+set}" "${LRFE_ORG_PARENT-}"
add orgPlace "${LRFE_ORG_PLACE+set}" "${LRFE_ORG_PLACE-}"

mkdir -p "$(dirname "$out")"
# written next to it, then moved: nginx never serves a half-written file
printf '{%s\n}\n' "$entries" > "$out.tmp"
mv "$out.tmp" "$out"
echo "site-config: wrote $out"
