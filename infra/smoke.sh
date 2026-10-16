#!/usr/bin/env bash
# Smoke test against a deployed collector (or `bun run dev` on localhost).
#
#   API=https://relay.withadi.dev ANALYTICS_WRITE_KEY=... ANALYTICS_EXPORT_KEY=... infra/smoke.sh
#
# Sends one cookieless page_view, one rejected event, one server event and, if WAIT=1, waits
# for Firehose's buffer (up to ~6 minutes) and finds the events again through GET /v1/pull.
set -euo pipefail
: "${API:?set API to the collector base URL}"
ORIGIN="${ORIGIN:-https://withadi.dev}"
UA="Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0 adi-smoke"
id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "health:   $(curl -fsS "$API/health")"
curl -fsS -o /dev/null "$API/web.js" && echo "snippet:  ok"

r="$(curl -sS -X POST "$API/v1/web" -H "Origin: $ORIGIN" -H "User-Agent: $UA" -H 'Content-Type: text/plain' \
  --data "{\"consent\":false,\"items\":[{\"id\":\"$id\",\"name\":\"page_view\",\"props\":{\"path\":\"/smoke-test\"}}]}")"
echo "page_view: $r"; echo "$r" | grep -q '"accepted":1' || fail "page_view not accepted"

r="$(curl -sS -X POST "$API/v1/web" -H "Origin: $ORIGIN" -H "User-Agent: $UA" -H 'Content-Type: text/plain' \
  --data '{"items":[{"name":"button_clicked","props":{}}]}')"
echo "unknown:  $r"; echo "$r" | grep -q 'not in the allowlist' || fail "unknown event was not rejected"

code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/v1/web" -H 'Origin: https://evil.example' --data '{"items":[]}')"
echo "foreign origin: $code"; [ "$code" = 403 ] || fail "foreign origin not refused"

if [ -n "${ANALYTICS_WRITE_KEY:-}" ]; then
  r="$(curl -sS -X POST "$API/v1/server" -H "Authorization: Bearer $ANALYTICS_WRITE_KEY" -H 'Content-Type: application/json' \
    --data '{"events":[{"event":"crm_company_added","distinct_id":"crm:company:smoke","properties":{"origin":"unknown"}}]}')"
  echo "server:   $r"; echo "$r" | grep -q '"accepted":1' || fail "server event not accepted"
fi

if [ "${WAIT:-0}" = 1 ] && [ -n "${ANALYTICS_EXPORT_KEY:-}" ]; then
  today="$(date -u +%F)"
  for i in $(seq 1 24); do
    if curl -fsS -H "Authorization: Bearer $ANALYTICS_EXPORT_KEY" "$API/v1/pull?since=$today" | grep -q "$id"; then
      echo "pull:     found $id after ~$((i * 15))s"; exit 0
    fi
    sleep 15
  done
  fail "event $id did not reach /v1/pull within 6 minutes"
fi
echo "OK"
