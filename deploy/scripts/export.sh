#!/usr/bin/env bash
# Exports one version as a bundle that installs at a site without internet access:
#
#   deploy/scripts/export.sh <version> [--blockchain]
#
# Writes deploy/dist/lrfe-<version>.tar, holding:
#   images.tar.gz       every image the site runs (docker save): lrfe-backend, lrfe-web, PostgreSQL,
#                       NATS, OpenBao (stored files are encrypted by default); with --blockchain also
#                       the blockchain node
#   docker-compose.yml  .env.example  openbao/  README.md (the install guide)
#   docs/inviting-users-and-assigning-roles.md (for the first administrator)
#   VERSION  SHA256SUMS
# The application's images must be built first, as a release (deploy/scripts/build.sh, never
# --worktree: a "-dirty" version is refused); the others are pulled
# here, so this machine needs internet access. --blockchain takes CARDANO_NETWORK (default preview).
set -euo pipefail

DEPLOY=$(cd "$(dirname "$0")/.." && pwd)
version=${1:-}
if [ -z "$version" ] || [[ $version == -* ]]; then
    echo "Usage: $0 <version> [--blockchain]" >&2
    exit 2
fi
shift
if [[ $version == *-dirty ]]; then
    echo "Not exported: $version was built from uncommitted changes. Commit, then build a release: deploy/scripts/build.sh" >&2
    exit 2
fi
# the bundled PostgreSQL always goes along: a site may use it even if it starts with its own server;
# OpenBao too: stored files are encrypted with its keys by default
profiles=(--profile postgres --profile bao)
for arg in "$@"; do
    case $arg in
        --blockchain) profiles+=(--profile blockchain) ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

# The images of this compose file, with placeholders for the settings it requires (nothing is started)
images=$(cd "$DEPLOY" && env -i PATH="$PATH" HOME="$HOME" LRFE_VERSION="$version" JWT_SECRET=x POSTGRES_PASSWORD=x \
    LRFE_PUBLIC_URL=http://x CARDANO_NETWORK="${CARDANO_NETWORK:-preview}" \
    docker compose --env-file /dev/null "${profiles[@]}" config --images | sort -u)

for image in $images; do
    case $image in
        lrfe-*)
            docker image inspect "$image" >/dev/null 2>&1 || { echo "$image is not built: deploy/scripts/build.sh $version" >&2; exit 1; }
            if [ "$(docker image inspect -f '{{index .Config.Labels "lrfe.build"}}' "$image")" = worktree ]; then
                echo "Not exported: $image was built from the checkout (--worktree), not from a commit: deploy/scripts/build.sh $version" >&2
                exit 2
            fi ;;
        *) docker pull -q "$image" >/dev/null ;;
    esac
done

out="$DEPLOY/dist/lrfe-$version"
rm -rf "$out"
mkdir -p "$out/openbao"
echo "Saving images:"
printf '  %s\n' $images
# shellcheck disable=SC2086
docker save $images | gzip -6 > "$out/images.tar.gz"
cp "$DEPLOY/docker-compose.yml" "$DEPLOY/.env.example" "$DEPLOY/README.md" "$out/"
mkdir -p "$out/docs"
cp "$DEPLOY/../angular-app/docs/user-guide/inviting-users-and-assigning-roles.md" "$out/docs/"
cp "$DEPLOY/openbao/openbao.hcl" "$DEPLOY/openbao/setup.sh" "$out/openbao/"
echo "$version" > "$out/VERSION"
(cd "$out" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS)
tar -C "$DEPLOY/dist" -cf "$DEPLOY/dist/lrfe-$version.tar" "lrfe-$version"
rm -rf "$out"

echo
echo "Bundle: $DEPLOY/dist/lrfe-$version.tar ($(du -h "$DEPLOY/dist/lrfe-$version.tar" | cut -f1))"
echo "SHA-256: $(sha256sum "$DEPLOY/dist/lrfe-$version.tar" | cut -d' ' -f1)"
