#!/bin/bash
set -eu

# The image's entrypoint waits for GOST, not its background warp-svc process.
# An OOM-killed daemon otherwise leaves a running container with dead DNS.
/entrypoint.sh &
entrypoint_pid=$!
trap 'kill -TERM "$entrypoint_pid" 2>/dev/null || true; exit 0' TERM INT

# Let the original entrypoint finish registration and network setup first.
sleep "$(( ${WARP_SLEEP:-2} + 10 ))"
while kill -0 "$entrypoint_pid" 2>/dev/null; do
    if ! pgrep -x warp-svc >/dev/null; then
        echo '[WARP] Daemon exited; restarting it in the existing network namespace.' >&2
        # Keep the container alive: replacing its network namespace strands
        # Lavalink and yt-cipher, which share it. Saved registration reconnects.
        sudo warp-svc --accept-tos &
    fi
    sleep 5
done

wait "$entrypoint_pid"
