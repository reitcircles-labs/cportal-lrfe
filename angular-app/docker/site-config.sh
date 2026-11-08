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
# (angular-app/projects/platform/src/lib/state/site-config.ts). An empty setting is written empty, and is not shown.
# Display texts only, readable by anyone who opens the portal: never put a secret here.
#
# Also the other origins documents may come from, for the content security policy
# (docker/security-headers.conf, API-822): with EDRMS_STORAGE=s3, documents open from links signed
# by the S3 bucket (AWS_BUCKET_NAME, AWS_BUCKET_REGION), so its origin is allowed in frames and
# images. Written as the nginx variable $lrfe_document_origins, empty with local storage.
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

origins_file=${DOCUMENT_ORIGINS_FILE:-/tmp/lrfe/document-origins.conf}
bucket=${AWS_BUCKET_NAME:-}
region=${AWS_BUCKET_REGION:-}
origins=''
if [ "${EDRMS_STORAGE:-local}" = s3 ]; then
    # only a valid bucket and region name gets into nginx's configuration
    if printf '%s' "$bucket" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' &&
        printf '%s' "$region" | grep -Eq '^[a-z0-9-]+$'; then
        case "$bucket" in
            # a bucket name with dots is signed on the region's host (path style)
            *.*) origins="https://s3.$region.amazonaws.com" ;;
            *) origins="https://$bucket.s3.$region.amazonaws.com" ;;
        esac
    else
        echo "site-config: AWS_BUCKET_NAME or AWS_BUCKET_REGION is not a valid name; documents stored in S3 will not open in the app" >&2
    fi
fi
mkdir -p "$(dirname "$origins_file")"
printf 'map $host $lrfe_document_origins {\n    default "%s";\n}\n' "$origins" > "$origins_file.tmp"
mv "$origins_file.tmp" "$origins_file"
echo "site-config: document origins: ${origins:-none}"
