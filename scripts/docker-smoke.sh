#!/usr/bin/env bash
# Build the local image, start it, and check health, a token, a submit and a clean stop.
# Needs Docker. Nothing is pushed to any registry.
set -euo pipefail

IMAGE="${IMAGE:-myinvois-emulator:smoke}"
NAME="myinvois-emulator-smoke-$$"
PORT="${PORT:-18787}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -t "$IMAGE" .
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8787" "$IMAGE" start --host 0.0.0.0 --port 8787 --clock fake --seed 42 >/dev/null

base="http://127.0.0.1:${PORT}"
for _ in $(seq 1 30); do
  if curl -fsS "$base/_emulator/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$base/_emulator/health" | grep -q '"status":"ok"'

test "$(docker exec "$NAME" id -un)" = node

token="$(curl -fsS -X POST "$base/connect/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=supplier-a&client_secret=supplier-a-secret&scope=InvoicingAPI' |
  node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).access_token))")"
test -n "$token"

doc='{"Invoice":[{"ID":[{"_":"DOCKER-1"}],"AccountingSupplierParty":[{"Party":[{"PartyIdentification":[{"ID":[{"_":"C00000000000","schemeID":"TIN"}]}]}]}],"AccountingCustomerParty":[{"Party":[{"PartyIdentification":[{"ID":[{"_":"IG00000000000","schemeID":"TIN"}]}]}]}]}]}'
body="$(DOC="$doc" node -e "const c=require('node:crypto');const b=Buffer.from(process.env.DOC);process.stdout.write(JSON.stringify({documents:[{format:'JSON',document:b.toString('base64'),documentHash:c.createHash('sha256').update(b).digest('hex'),codeNumber:'DOCKER-1'}]}))")"
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/v1.0/documentsubmissions/" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' --data "$body")"
test "$status" = 202

health="$(docker inspect --format '{{.State.Health.Status}}' "$NAME")"
echo "container health: $health"

# A clean SIGTERM shutdown should exit 0 well within docker's 10-second grace period.
docker stop -t 10 "$NAME" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$NAME")" = 0
echo "docker smoke ok"
