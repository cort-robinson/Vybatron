#!/bin/bash
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
image=$(awk '/image: caomingjun\/warp@sha256:/ {gsub(/\r/, ""); print $2; exit}' "$repo_dir/docker-compose.yml")
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir "$fixture_dir/bin"

# Exercise real process exits in a disposable PID/network namespace. No WARP
# registration, credentials, tunnel device, or external network is needed.
cat > "$fixture_dir/entrypoint.sh" <<'SH'
#!/bin/bash
echo $$ > /tmp/entrypoint-pid
warp-svc --accept-tos &
sleep 3600 &
wait $!
SH
cat > "$fixture_dir/bin/warp-svc" <<'SH'
#!/bin/bash
exec /tmp/warp-svc 3600
SH
cat > "$fixture_dir/bin/sudo" <<'SH'
#!/bin/bash
exec "$@"
SH
cat > "$fixture_dir/run.sh" <<'SH'
#!/bin/bash
set -euo pipefail
export PATH="/test/bin:$PATH"
# A copied binary retains the real daemon's process name for pgrep.
cp /bin/sleep /tmp/warp-svc
bash /supervise.sh &
supervisor=$!
sleep 11
entrypoint=$(cat /tmp/entrypoint-pid)
daemon=$(pgrep -x warp-svc)
test -n "$daemon"

for attempt in 1 2; do
    kill -KILL "$daemon"
    replacement=''
    for tick in {1..8}; do
        sleep 1
        replacement=$(pgrep -x warp-svc || true)
        if [ -n "$replacement" ] && [ "$replacement" != "$daemon" ]; then
            break
        fi
    done
    test -n "$replacement"
    test "$replacement" != "$daemon"
    kill -0 "$supervisor" "$entrypoint"
    test "$(cat /tmp/entrypoint-pid)" = "$entrypoint"
    echo "PASS: daemon death $attempt recovered without replacing the entrypoint"
    daemon=$replacement
done

# An actual entrypoint failure must still propagate to Docker's restart policy.
kill -TERM "$entrypoint"
set +e
wait "$supervisor"
status=$?
set -e
test "$status" -eq 143
echo 'PASS: entrypoint failure propagated'
SH
chmod +x "$fixture_dir/entrypoint.sh" "$fixture_dir/bin/"*

docker run --rm --network none --user root --entrypoint /usr/bin/timeout \
    -e WARP_SLEEP=0 \
    -v "$fixture_dir:/test:ro" \
    -v "$fixture_dir/entrypoint.sh:/entrypoint.sh:ro" \
    -v "$repo_dir/warp/supervise.sh:/supervise.sh:ro" \
    "$image" --signal=KILL 45s /bin/bash /test/run.sh
