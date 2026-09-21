#!/usr/bin/env bash
# Runs the pre-migration preflight against the live project, READ-ONLY.
#
# THE TOKEN NEVER ENTERS A TRANSCRIPT. It is read from a file, the same pattern
# already used for the TwelveData key:
#
#     printf '%s' 'sbp_...' > /tmp/sb_token && chmod 600 /tmp/sb_token
#     ./scripts/ipo_preflight_query.sh
#
# Do not pass it on the command line and do not export it inline in a shell that
# is being recorded — either would put it in the history.
#
# WHAT IT USES. A Supabase *personal access token* (sbp_...) against the
# Management API. That is NOT the database password and NOT the service-role
# key; it cannot be used to apply a migration here, because every statement sent
# is checked to be a SELECT first.
#
# WHAT IT CANNOT DO. It cannot apply anything. The read-only guard below rejects
# any query containing a write verb, so this cannot become a general
# "run any SQL on production" tool.

set -uo pipefail

TOKEN_FILE=${TOKEN_FILE:-/tmp/sb_token}
SQL_FILE=${SQL_FILE:-supabase/queries/ipo_premigration_preflight.sql}

if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  TOKEN=$SUPABASE_ACCESS_TOKEN
elif [ -r "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
else
  echo "No token. Write one to $TOKEN_FILE (chmod 600) or export SUPABASE_ACCESS_TOKEN." >&2
  exit 1
fi

REF=${SUPABASE_PROJECT_REF:-$(grep -m1 '^project_id' supabase/config.toml | cut -d'"' -f2)}
[ -n "$REF" ] || { echo "Could not determine the project ref." >&2; exit 1; }

[ -r "$SQL_FILE" ] || { echo "Missing $SQL_FILE" >&2; exit 1; }
SQL=$(cat "$SQL_FILE")

# Read-only guard. Comments are stripped first so the word "insert" inside an
# explanatory comment cannot trip it, and so a write verb cannot hide in one.
STRIPPED=$(printf '%s' "$SQL" | sed 's/--.*$//')
if printf '%s' "$STRIPPED" | grep -qiE '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b'; then
  echo "Refusing: $SQL_FILE contains a write verb outside comments." >&2
  exit 1
fi

echo "project $REF — read-only preflight" >&2

RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(jq -nc --arg q "$SQL" '{query:$q}')")

CODE=$(printf '%s' "$RESP" | tail -n1)
BODY=$(printf '%s' "$RESP" | sed '$d')

case "$CODE" in
  200) printf '%s\n' "$BODY" | jq -r '
         (["section","item","value"] | @tsv),
         (.[] | [.section, .item, .value] | @tsv)' | column -t -s $'\t' ;;
  401|403) echo "Rejected ($CODE). The token is not valid for this project." >&2; exit 1 ;;
  404) echo "404 — the Management API query endpoint is not available for this project." >&2
       echo "Run $SQL_FILE in the Supabase SQL editor instead." >&2; exit 1 ;;
  *)   echo "HTTP $CODE" >&2; printf '%s\n' "$BODY" >&2; exit 1 ;;
esac
