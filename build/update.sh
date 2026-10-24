#!/usr/bin/env bash
#
# Rebuilds bymr.swf from the newest Backyard Monsters Refitted release that the game server
# accepts, with the browser changes in web-client.patch. Run by .github/workflows/update-game.yml.
#
#   build/update.sh          update if there's a newer release the server accepts
#   FORCE=1 build/update.sh  rebuild the newest release even if it's already live
#
# Leaves the site unchanged if it's up to date, if the server doesn't accept the new release yet,
# or (failing) if the patch doesn't apply to it. Writes `updated=<version>` to $GITHUB_OUTPUT
# after an update.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="$(dirname "$HERE")"
UPSTREAM="${UPSTREAM:-https://github.com/bym-refitted/backyard-monsters-refitted}"
SERVER="${SERVER:-https://server.bymrefitted.com/}"
FLEX_URL="https://archive.apache.org/dist/flex/4.16.1/binaries/apache-flex-sdk-4.16.1-bin.tar.gz"
WORK="${WORK:-$(mktemp -d)}"

current="$(cat "$HERE/client-version")"
# Release tags look like v1.7.8-beta (old tags like v.0.1.3-alpha are from another numbering).
latest="$(git ls-remote --tags --refs "$UPSTREAM" 'v*' | sed 's#.*refs/tags/##' |
  grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$' | sort -V | tail -1)"
echo "Live: $current. Newest release: $latest."

if [ "$latest" = "$current" ] && [ -z "${FORCE:-}" ]; then
  echo "Up to date."
  exit 0
fi

# A release can be tagged before the servers move to it; the old client still works until then.
status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data "apiVersion=$latest" "${SERVER}init")"
if [ "$status" != 200 ]; then
  echo "The game server doesn't accept $latest yet (HTTP $status). Keeping $current."
  exit 0
fi

echo "Building $latest"
# Full history: a three-way merge of the patch needs the files it was made against.
git clone -q --branch "$latest" "$UPSTREAM" "$WORK/src"
git -C "$WORK/src" apply --3way "$HERE/web-client.patch"

FLEX_HOME="${FLEX_HOME:-$WORK/flex}"
if [ ! -x "$FLEX_HOME/bin/mxmlc" ]; then
  mkdir -p "$FLEX_HOME"
  curl -sSL "$FLEX_URL" | tar xz --strip-components=1 -C "$FLEX_HOME"
fi

# The Flex SDK looks for playerglobal.swc under {PLAYERGLOBAL_HOME}/<major>.<minor>/.
mkdir -p "$WORK/playerglobal/11.0"
cp "$WORK/src/playerglobal.swc" "$WORK/playerglobal/11.0/"

# Same options as pwa/build.sh in the game repository. The URLs are only defaults: the page
# passes the servers in as flashvars.
PLAYERGLOBAL_HOME="$WORK/playerglobal" "$FLEX_HOME/bin/mxmlc" \
  -source-path="$WORK/src/client/scripts" \
  -target-player=11.0 -swf-version=13 \
  -default-frame-rate=40 -default-background-color=#FFFFFF -default-size 760 670 \
  -optimize=true -strict=true -warnings=false -use-network=true \
  -static-link-runtime-shared-libraries=true \
  "-define=CONFIG::SERVER_URL,'http://localhost:3001/'" \
  "-define=CONFIG::CDN_URL,'http://localhost:3001/'" \
  -output="$WORK/bymr.swf" \
  "$WORK/src/client/scripts/GAME.as"

cp "$WORK/bymr.swf" "$SITE/bymr.swf"
echo "$latest" > "$HERE/client-version"
sed -i "s/release v[0-9][^ ]* with the/release $latest with the/" "$SITE/README.md"
echo "Updated to $latest."
echo "updated=$latest" >> "${GITHUB_OUTPUT:-/dev/null}"
