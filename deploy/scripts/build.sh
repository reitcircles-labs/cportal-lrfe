#!/usr/bin/env bash
# Builds the application's two images, tagged with one version:
#   lrfe-backend:<version>   every backend service (backend/Dockerfile)
#   lrfe-web:<version>       the web app with its nginx (angular-app/Dockerfile)
#
#   deploy/scripts/build.sh                    a release: from the last commit only, version
#                                              <backend package version>-<commit>, e.g. 0.1.0-5dc1dae
#   deploy/scripts/build.sh 1.2.0              a release with an explicit version
#   deploy/scripts/build.sh --worktree [ver]   the checkout as it is, with uncommitted changes (for
#                                              testing before a commit, e.g. npm run test:docker)
#
# A release is built from `git archive` of the commit, so nothing uncommitted or untracked (local
# notes, logs, files of one server) can get into an image, and its base images are pulled fresh.
# --worktree builds the files on disk and marks the default version "-dirty" when anything changed,
# so such an image never claims to be a commit it is not; export.sh refuses those images.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
worktree=false
if [ "${1:-}" = --worktree ]; then worktree=true; shift; fi
commit=$(git -C "$REPO" rev-parse HEAD)
if [ $# -ge 1 ]; then
    version=$1
else
    # the version of the commit that is built, not of the files on disk (unless --worktree)
    if $worktree; then pkg=$(cat "$REPO/backend/package.json"); else pkg=$(git -C "$REPO" show HEAD:backend/package.json); fi
    version="$(printf '%s' "$pkg" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')-${commit:0:7}"
    if $worktree && [ -n "$(git -C "$REPO" status --porcelain -- backend angular-app)" ]; then version="$version-dirty"; fi
fi
if ! [[ $version =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "Not a valid image tag: $version" >&2
    exit 2
fi

if $worktree; then
    src=$REPO
    # marked, so that export.sh refuses it whatever its version
    extra=(--label lrfe.build=worktree)
else
    src=$(mktemp -d)
    trap 'rm -rf "$src"' EXIT
    git -C "$REPO" archive HEAD backend angular-app | tar -x -C "$src"
    extra=(--pull)
fi

build() {
    local name=$1 dir=$2
    echo "== $name:$version"
    docker build "${extra[@]}" \
        --build-arg VERSION="$version" --build-arg REVISION="$commit" \
        -t "$name:$version" "$src/$dir"
}

build lrfe-backend backend
build lrfe-web angular-app

echo
echo "Built lrfe-backend:$version and lrfe-web:$version"
echo "Run them:    LRFE_VERSION=$version in deploy/.env, then docker compose up -d (in deploy/)"
$worktree || echo "Export them: deploy/scripts/export.sh $version"
