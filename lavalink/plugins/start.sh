#!/bin/sh
# Lavalink entrypoint (Compose mounts this folder at /opt/vybatron). Seeds the
# plugins folder with the locally built vybatron-audio plugin and with jars
# ops/recovery.py kept for plugin versions application.yml still declares, so
# Lavalink loads those without downloading them. Other jars stay out because
# Lavalink loads every jar in its plugins folder.
source="${1:-/opt/vybatron}"
mkdir -p plugins
for jar in "$source"/*.jar; do
  [ -f "$jar" ] || continue
  name=$(basename "$jar" .jar)
  if [ "$name" = vybatron-audio ] || grep -qF ":${name%-*}:${name##*-}\"" application.yml; then
    cp "$jar" plugins/ || true
  fi
done
exec java -jar Lavalink.jar
