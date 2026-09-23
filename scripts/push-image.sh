#!/usr/bin/env bash
# Pull the prebuilt Kokoro-FastAPI CPU image and push it to this account's
# Snowflake image repository.
#
# Note the --platform flag: SPCS x86 instance families need linux/amd64, and
# this is likely being run from an Apple Silicon machine where the default
# pull would resolve to arm64.
#
# Uses your default Snowflake CLI connection. Override with either:
#   SNOWFLAKE_DEFAULT_CONNECTION_NAME=my_conn ./scripts/push-image.sh
#   SNOWFLAKE_CONNECTION=my_conn ./scripts/push-image.sh

set -euo pipefail

# Accept either variable name; fall back to the CLI's own default connection.
CONNECTION="${SNOWFLAKE_CONNECTION:-${SNOWFLAKE_DEFAULT_CONNECTION_NAME:-}}"
CONN_ARGS=()
if [[ -n "${CONNECTION}" ]]; then
	CONN_ARGS=(-c "${CONNECTION}")
fi

# Derive the registry hostname from the account rather than hardcoding it, so
# this works on any account. The registry host is the account identifier with
# underscores replaced by hyphens.
echo "==> Resolving image repository URL"
REPO="$(snow sql "${CONN_ARGS[@]}" \
	-q "SHOW IMAGE REPOSITORIES LIKE 'IMAGES' IN SCHEMA VOICE_DEMO.TTS" \
	--format json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["repository_url"])')"

if [[ -z "${REPO}" ]]; then
	echo "Could not resolve the image repository. Run 'npm run tts:setup' first." >&2
	exit 1
fi

SRC="ghcr.io/remsky/kokoro-fastapi-cpu:latest"
DEST="${REPO}/kokoro-tts:latest"

echo "==> Repository: ${REPO}"
echo "==> Pulling ${SRC} (linux/amd64)"
docker pull --platform linux/amd64 "${SRC}"

echo "==> Tagging as ${DEST}"
docker tag "${SRC}" "${DEST}"

echo "==> Logging in to the Snowflake image registry"
snow spcs image-registry login "${CONN_ARGS[@]}"

echo "==> Pushing (this takes a few minutes)"
docker push "${DEST}"

echo "==> Done. Verify with:"
echo "    snow sql -q \"SHOW IMAGES IN IMAGE REPOSITORY VOICE_DEMO.TTS.IMAGES\""
