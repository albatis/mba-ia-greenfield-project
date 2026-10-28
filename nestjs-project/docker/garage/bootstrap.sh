#!/usr/bin/env bash
# Idempotent Garage bootstrap — run on the host from nestjs-project/:
#   ./docker/garage/bootstrap.sh
# The Garage image is built FROM scratch (no shell), so every step is a
# `docker compose exec storage /garage ...` call driven from the host.
set -euo pipefail

cd "$(dirname "$0")/../.."

KEY_NAME="streamtube-dev"
# Must match S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY in .env
ACCESS_KEY_ID="GK1d8b0106b0f6bd86d6cdd15c"
SECRET_ACCESS_KEY="149499a81e704dc35e7ca75f1e5d75874578a91b0a3ba3eee1a83cf6859703a8"

PRIVATE_BUCKETS=(videos videos-test)
PUBLIC_BUCKETS=(thumbnails thumbnails-test)

garage() {
  docker compose exec -T storage /garage "$@" 2> >(grep -v "INFO" >&2)
}

echo "==> Waiting for Garage to answer"
for _ in $(seq 1 30); do
  garage status >/dev/null 2>&1 && break
  sleep 1
done

echo "==> Layout (single node)"
if garage status | grep -q "NO ROLE ASSIGNED"; then
  NODE_ID="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z dc1 -c 1G "$NODE_ID" >/dev/null
  garage layout apply --version 1 >/dev/null
else
  echo "    layout already applied"
fi

echo "==> Access key"
if garage key info "$ACCESS_KEY_ID" >/dev/null 2>&1; then
  echo "    key $KEY_NAME already imported"
else
  garage key import --yes -n "$KEY_NAME" "$ACCESS_KEY_ID" "$SECRET_ACCESS_KEY" >/dev/null
fi

echo "==> Buckets"
for bucket in "${PRIVATE_BUCKETS[@]}" "${PUBLIC_BUCKETS[@]}"; do
  if garage bucket info "$bucket" >/dev/null 2>&1; then
    echo "    bucket $bucket already exists"
  else
    garage bucket create "$bucket" >/dev/null
  fi
  # Owner is required for PutBucketCors (storage:cors script)
  garage bucket allow --read --write --owner "$bucket" --key "$ACCESS_KEY_ID" >/dev/null
done

echo "==> Public website access (thumbnails only)"
for bucket in "${PUBLIC_BUCKETS[@]}"; do
  garage bucket website --allow "$bucket" >/dev/null
done

echo "==> Done"
garage bucket list
