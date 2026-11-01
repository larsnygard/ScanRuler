#!/usr/bin/env bash
# Deploy ScanRuler (CNCKitchen/scanruler, AGPL-3.0) to https://snart.com/scanruler
#
# Bygges med vite (oppsett: node >= 22), og byggast med --base=./ slik at
# alle asset-lenkjer blir relative — appen må fungere under undermappa
# /scanruler/ på vertsrooten, ikkje på domenenamnrot.
# Heile dist/ rsyncast til webrota; Varnish purgast etterpå.
set -euo pipefail

cd "$(dirname "$0")"

npm run build >/dev/null
node node_modules/vite/bin/vite.js build --base=./ >/dev/null

HOST="proisp"
DEST="$(ssh -o BatchMode=yes "$HOST" 'readlink -f "$HOME/www/scanruler" 2>/dev/null || echo "$HOME/www/scanruler"')"
ssh "$HOST" "mkdir -p '$DEST'"

rsync -az --delete dist/ "$HOST":"$DEST"/

echo -n "Varnish-purge /scanruler/ → "
ssh -o BatchMode=yes "$HOST" \
  'curl -s -o /dev/null -w "%{http_code}\n" -X PURGE "https://snart.com/scanruler/"'

echo
echo "Deployed to: https://snart.com/scanruler/"
echo "  remote:    $DEST"
echo "  files:     $(ssh "$HOST" "find '$DEST' -type f | wc -l")"
echo -n "  live no:   "
curl -s -o /dev/null -w "%{http_code}\n" https://snart.com/scanruler/
