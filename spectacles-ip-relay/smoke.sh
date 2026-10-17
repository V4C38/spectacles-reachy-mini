#!/bin/sh
# Create, read, refresh, delete, then confirm the PIN is gone.
# Usage: ./smoke.sh https://spectacles-ip-relay.<account>.workers.dev
set -eu
BASE="${1:?usage: ./smoke.sh https://host}"
BASE="${BASE%/}"

CREATE=$(curl -sf -X POST "$BASE/v1/pins" \
    -H "content-type: application/json" \
    -d '{"ip":"192.168.1.10","port":8765}')
PIN=$(printf '%s' "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pin"])')
KEY=$(printf '%s' "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')

curl -sf "$BASE/v1/pins/$PIN" | python3 -c 'import json,sys; body=json.load(sys.stdin); assert body["ip"]=="192.168.1.10" and body["port"]==8765'
curl -sf -X PUT "$BASE/v1/pins/$PIN" -H "authorization: Bearer $KEY" >/dev/null
curl -sf -X DELETE "$BASE/v1/pins/$PIN" -H "authorization: Bearer $KEY" >/dev/null

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/pins/$PIN")
test "$CODE" = "404"
echo "ok pin=$PIN"
