#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

export PGDATA=/tmp/pocket-postgres/data
export PGHOST=/tmp/pocket-postgres/socket
export PGUSER=postgres
export DATABASE_URL='postgresql://pocket_tasks@localhost/pocket_tasks?host=/tmp/pocket-postgres/socket'
app_pid=""
postgres_pid=""

cleanup() {
  local status=$?
  trap - EXIT TERM INT
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid"
    wait "$app_pid" || true
  fi
  if [[ -n "$postgres_pid" ]] && kill -0 "$postgres_pid" 2>/dev/null; then
    pg_ctl -D "$PGDATA" -m fast -w stop || status=1
    wait "$postgres_pid" || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

mkdir -p "$PGHOST" "$PGDATA"
if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  initdb -D "$PGDATA" --username=postgres --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C
fi
postgres -D "$PGDATA" -c listen_addresses='' -c unix_socket_directories="$PGHOST" \
  -c shared_buffers=64MB -c max_connections=30 \
  -c log_statement=none -c log_min_error_statement=panic -c log_error_verbosity=terse \
  -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 &
postgres_pid=$!

ready=false
for ((i = 0; i < 60; i++)); do
  if pg_isready -q; then ready=true; break; fi
  if ! kill -0 "$postgres_pid" 2>/dev/null; then
    echo "PostgreSQL exited before it became ready." >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "PostgreSQL did not become ready within 60 seconds." >&2
  exit 1
fi
if [[ "$(psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'pocket_tasks'")" != "1" ]]; then
  createuser --no-superuser --no-createdb --no-createrole pocket_tasks
fi
if [[ "$(psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'pocket_tasks'")" != "1" ]]; then
  createdb --owner=pocket_tasks pocket_tasks
fi

node dist/server/index.js &
app_pid=$!
set +e
wait -n "$app_pid" "$postgres_pid"
status=$?
set -e
echo "A required process exited (status $status); stopping the container." >&2
if [[ "$status" -eq 0 ]]; then status=1; fi
exit "$status"
