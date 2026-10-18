#!/usr/bin/env bash
# Starts (or reuses) the throwaway Postgres the integration and e2e tests write
# to, then prints the TEST_DATABASE_URL to export. Image, user, password and
# database name match the CI service (.github/workflows/ci-typescript.yml);
# only the host port differs, so a local run can't collide with a real server.
# The container is left running for the next test run - `docker rm -f
# bas-test-pg` throws it away.
set -euo pipefail

NAME=bas-test-pg
IMAGE=postgres:17
DB=test
HOST_PORT=55432
READY_TIMEOUT=30
URL="postgres://postgres:postgres@localhost:$HOST_PORT/$DB"

if docker inspect "$NAME" >/dev/null 2>&1; then
  echo "reusing container $NAME"
  docker start "$NAME" >/dev/null # no-op when it is already running
else
  echo "starting container $NAME ($IMAGE)"
  docker run -d --rm --name "$NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" \
    -p "$HOST_PORT:5432" "$IMAGE" >/dev/null
fi

# Postgres only accepts connections a moment after its container starts.
for _ in $(seq "$READY_TIMEOUT"); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then
    # A reused container that was created without POSTGRES_DB=$DB has no
    # database yet.
    docker exec "$NAME" psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1 ||
      docker exec "$NAME" createdb -U postgres "$DB"
    echo "export TEST_DATABASE_URL=$URL"
    exit 0
  fi
  sleep 1
done

echo "error: $NAME did not accept connections within ${READY_TIMEOUT}s - check docker logs $NAME" >&2
exit 1
