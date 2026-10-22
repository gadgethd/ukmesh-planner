#!/usr/bin/env bash
# CI scratch-image preparation: tolerate transient registry 5xx/network errors.
# Fixture assertions run once, separately, after this bounded download step.
set -euo pipefail
fixture_image=postgres:16-alpine
if docker image inspect "$fixture_image" >/dev/null 2>&1; then
  exit 0
fi
for fixture_attempt in 1 2 3; do
  if docker pull "$fixture_image"; then
    exit 0
  fi
  if [ "$fixture_attempt" -lt 3 ]; then sleep 5; fi
done
printf 'Failed to pull scratch image %s after three attempts\n' "$fixture_image" >&2
exit 1
