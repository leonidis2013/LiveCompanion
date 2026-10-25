/*
 * The shell scripts LiveCompanion runs on a device. Each one is joined to
 * sh/prelude.sh, which defines as_root (sudo when needed) and kv.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PRELUDE = fs.readFileSync(path.join(__dirname, 'sh', 'prelude.sh'), 'utf8');
const PROBE = fs.readFileSync(path.join(__dirname, 'sh', 'probe.sh'), 'utf8');

/** Single-quote a value for sh. */
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

const probe = () => PRELUDE + PROBE;

const companionUpdate = () => PRELUDE + `set -e
echo "Updating Companion to the newest stable build..."
as_root companion-update stable
echo "companion-update finished."
`;

const satelliteUpdate = () => PRELUDE + `set -e
echo "Updating Companion Satellite to the newest stable build..."
as_root satellite-update stable
echo "satellite-update finished."
`;

const osUpdate = () => PRELUDE + `set -e
echo "Refreshing package lists..."
as_root env DEBIAN_FRONTEND=noninteractive apt-get update
echo "Installing updates..."
as_root env DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
echo "Package upgrade finished."
`;

/** Pull the newer image and recreate the one compose service. */
const dockerUpdate = ({ cwd, svc }) => PRELUDE + `set -e
cd ${shq(cwd)}
if as_root docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "Docker Compose is not installed on this device"; exit 1; fi
echo "Pulling the newer image for ${String(svc).replace(/[^A-Za-z0-9_.-]/g, '')}..."
as_root $DC pull ${shq(svc)}
echo "Restarting the container..."
as_root $DC up -d ${shq(svc)}
echo "Docker update finished."
`;

const reboot = () => PRELUDE + `echo "Rebooting in 3 seconds..."
sleep 3
as_root systemctl reboot || as_root reboot
`;

/** Stream a config backup to stdout as a .tgz. Companion is stopped while it is read, then started again. */
const backupCompanion = ({ cfg }) => PRELUDE + `dir=${shq(cfg)}
as_root systemctl stop companion >/dev/null 2>&1
as_root tar -czf - -C "$(dirname "$dir")" "$(basename "$dir")"
rc=$?
as_root systemctl start companion >/dev/null 2>&1
exit $rc
`;

const backupFile = ({ file }) => PRELUDE + `as_root tar -czf - -C "$(dirname ${shq(file)})" "$(basename ${shq(file)})"
`;

/** Put LiveCompanion's public key on the device (used once, with a password login). */
const installKey = ({ pub }) => PRELUDE + `set -e
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
grep -qF ${shq(pub)} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${shq(pub)} >> "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh/authorized_keys"
echo done
`;

/** Wrap a script into the single command string handed to ssh. */
function command(script, { pw = false, env = {} } = {}) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const pre = Object.keys(env).map((k) => k + '=' + shq(env[k])).join(' ');
  return (pw ? 'IFS= read -r LC_PWV; export LC_PWV; ' : '') + (pre ? pre + ' ' : '') + 'sh -c "$(printf %s ' + b64 + ' | base64 -d)"';
}

/** Start a script that keeps running if the connection drops. Prints LC_STARTED. */
function launch(id, script, { pw = false } = {}) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return (pw ? 'IFS= read -r LC_PWV; export LC_PWV; ' : '') +
    'd="${LC_ROOT:-}/tmp/livecompanion"; mkdir -p "$d" || exit 1; chmod 700 "$d"; ' +
    'printf %s ' + b64 + ' | base64 -d > "$d/' + id + '.sh" || exit 1; rm -f "$d/' + id + '.rc"; : > "$d/' + id + '.log"; ' +
    'if command -v setsid >/dev/null 2>&1; then S=setsid; else S=; fi; ' +
    '$S nohup sh -c \'sh "$1/' + id + '.sh" > "$1/' + id + '.log" 2>&1 < /dev/null; echo $? > "$1/' + id + '.rc"\' sh "$d" >/dev/null 2>&1 < /dev/null & ' +
    'echo LC_STARTED';
}

/**
 * Read what a started script has printed since byte `offset` (at most 256 KB at a time),
 * and whether it has finished.
 */
function poll(id, offset) {
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  return 'd="${LC_ROOT:-}/tmp/livecompanion"; f="$d/' + id + '.log"; r="$d/' + id + '.rc"; o=' + off + '; ' +
    'if [ -f "$f" ]; then s=$(wc -c < "$f"); else s=0; fi; e=$s; ' +
    'if [ $((e - o)) -gt 262144 ]; then e=$((o + 262144)); fi; ' +
    'echo LC_SIZE=$s; echo LC_NEXT=$e; if [ -f "$r" ]; then echo LC_RC=$(cat "$r"); else echo LC_RC=; fi; echo LC_DATA; ' +
    'if [ "$e" -gt "$o" ]; then head -c "$e" "$f" | tail -c +$((o + 1)); fi';
}

function cleanup(id) {
  return 'd="${LC_ROOT:-}/tmp/livecompanion"; rm -f "$d/' + id + '.sh" "$d/' + id + '.log" "$d/' + id + '.rc"; echo ok';
}

module.exports = { probe, companionUpdate, satelliteUpdate, osUpdate, dockerUpdate, reboot, backupCompanion, backupFile, installKey, command, launch, poll, cleanup, shq };
