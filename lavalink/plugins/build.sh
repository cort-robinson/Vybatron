#!/usr/bin/env bash
# Builds lavalink/plugins/vybatron-audio.jar against the libraries inside the
# running Lavalink image, offline, with the same pinned JDK the playback probe
# uses. Run on the VPS from the compose checkout before (re)creating Lavalink:
#   lavalink/plugins/build.sh [lavalink-container]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
container="${1:-vybertron-lavalink}"
JDK='eclipse-temurin:17-jdk@sha256:36d9a76dc231587873b103c68a789b85d91b41d314dda69730d6bc43a777f2a9'
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/lib" "$work/classes/lavalink-plugins"
docker cp "$container:/opt/Lavalink/Lavalink.jar" "$work/Lavalink.jar" >/dev/null
python3 - "$work" <<'PY'
import os, sys, zipfile
work = sys.argv[1]
with zipfile.ZipFile(os.path.join(work, 'Lavalink.jar')) as archive:
    for name in archive.namelist():
        if name.startswith('BOOT-INF/lib/') and name.endswith('.jar'):
            with open(os.path.join(work, 'lib', os.path.basename(name)), 'wb') as target:
                target.write(archive.read(name))
PY
sources=$(cd "$here/vybatron-audio/src" && find . -name '*.java' | sed 's#^\./#/src/#')
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m --memory 512m --memory-swap 512m --cpus 1 \
  -v "$work:/work" -v "$here/vybatron-audio/src:/src:ro" --entrypoint javac "$JDK" \
  --release 17 -nowarn -cp '/work/lib/*' -d /work/classes $sources
printf 'name=vybatron-audio\npath=vybatron.audio\nversion=1.0.0\n' > "$work/classes/lavalink-plugins/vybatron-audio.properties"
python3 - "$work/classes" "$here/vybatron-audio.jar.tmp" <<'PY'
import os, sys, zipfile
root, target = sys.argv[1], sys.argv[2]
# Directory entries matter: Spring finds the plugin's package by scanning for them.
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as jar:
    for folder, _, files in sorted(os.walk(root)):
        relative = os.path.relpath(folder, root).replace(os.sep, '/')
        if relative != '.': jar.writestr(relative + '/', '')
        for name in sorted(files):
            path = os.path.join(folder, name)
            jar.write(path, os.path.relpath(path, root).replace(os.sep, '/'))
PY
chmod 644 "$here/vybatron-audio.jar.tmp"
mv "$here/vybatron-audio.jar.tmp" "$here/vybatron-audio.jar"
echo "Built $here/vybatron-audio.jar"
