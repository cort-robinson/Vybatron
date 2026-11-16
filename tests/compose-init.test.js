import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A healthcheck that hits its timeout leaves its child process to the container's
// PID 1. An application that runs as PID 1, like Lavalink's JVM, never reaps it,
// so each timeout leaves a zombie that counts against pids_limit until the
// container can no longer start threads (2026-11-15: 205 zombie wgets, every song
// failed). `init: true` puts a reaper at PID 1.
const services = file => {
  const found = new Map();
  let name = null; let inServices = false;
  for (const line of readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n')) {
    if (/^\S/.test(line)) { inServices = line.startsWith('services:'); name = null; continue; }
    const service = inServices && /^ {2}([\w-]+):\s*$/.exec(line);
    if (service) { name = service[1]; found.set(name, []); continue; }
    if (name) found.get(name).push(line);
  }
  return found;
};

for (const file of ['docker-compose.yml', 'docker-compose.portal.yml']) {
  test(`${file}: every service with a healthcheck runs an init that reaps its processes`, () => {
    const checked = [...services(file)].filter(([, lines]) => lines.some(line => /^ {4}healthcheck:/.test(line)));
    assert.ok(checked.length > 0);
    for (const [name, lines] of checked) {
      assert.ok(lines.some(line => /^ {4}init:\s*true\s*$/.test(line)), `${name} has a healthcheck but no init: true`);
    }
  });
}
