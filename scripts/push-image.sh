#!/usr/bin/env bash
# Pull the prebuilt Kokoro-FastAPI CPU image and push it to this account's
# Snowflake image repository.
#
# Note the --platform flag: SPCS x86 instance families need linux/amd64, and
# this is likely being run from an Apple Silicon machine where the default
# pull would resolve to arm64.

set -euo pipefail

CONNECTION="${SNOWFLAKE_CONNECTION:-sfsenorthamerica-rmoceri_awse1}"
REPO="sfsenorthamerica-rmoceri-awse1.registry.snowflakecomputing.com/voice_demo/tts/images"
SRC="ghcr.io/remsky/kokoro-fastapi-cpu:latest"
DEST="${REPO}/kokoro-tts:latest"

echo "==> Pulling ${SRC} (linux/amd64)"
docker pull --platform linux/amd64 "${SRC}"

echo "==> Tagging as ${DEST}"
docker tag "${SRC}" "${DEST}"

echo "==> Logging in to the Snowflake image registry"
snow spcs image-registry login -c "${CONNECTION}"

echo "==> Pushing (this takes a few minutes)"
docker push "${DEST}"

echo "==> Done. Verify with:"
echo "    snow sql -c ${CONNECTION} -q \"SHOW IMAGES IN IMAGE REPOSITORY VOICE_DEMO.TTS.IMAGES\""
