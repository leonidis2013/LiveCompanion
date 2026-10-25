# LiveCompanion

One dashboard for the Bitfocus Companion installs in your building. Add your controllers, Satellites and Docker hosts, see which ones have a newer **stable** Companion / Satellite or operating system updates waiting, and update them from one place. Same look and settings layout as LiveMic and LivePi.

- Adds devices by **network search** or by hand, over **SSH** (key or password).
- Finds out by itself what is on each device: Companion (Companion Pi), Companion Satellite, Companion in Docker, and the OS (apt based: Debian, Ubuntu, Raspberry Pi OS).
- Compares against the newest stable build Bitfocus publishes. Beta builds are never offered.
- Updates one device, one item, or everything at once, always after a confirm window.
- **Backs up the Companion / Satellite configuration to this server before each update.** If the backup fails, nothing is changed. The newest few are kept.
- Shows **Reboot needed** after updates, with a Reboot button, and waits for the device to come back.
- Checks everything **daily** (default 03:30) and with **Check now**. Badges on the dashboard, plus an optional **email** when something new appears.

## Run it

Docker / Docker Compose:

```
docker compose up -d
```

Open `http://<this machine>:8080`, click the gear, **Devices**.

TrueNAS SCALE: Apps > Discover Apps > Custom App > **Install via YAML**, paste `truenas-app.yaml`, set the dataset path, and give uid 1000 write access to it. Images are built for amd64 and arm64 by the GitHub workflow (`ghcr.io/leonidis2013/livecompanion`).

Without Docker: `node server.js` (Node 18+, no npm packages, needs `ssh` and `ssh-keygen` installed). `node server.js --demo` shows six simulated devices.

Settings, the SSH key, host keys and backups live in `/data` (the volume).

## Preparing a device

LiveCompanion logs in over SSH and runs the same commands you would. The login user must be **root**, or a user that can use **sudo**.

1. Turn on SSH on the Pi / server.
2. In **Settings > Devices > Add a device** enter address, user, and either:
   - **Key**: add the line shown under *LiveCompanion's SSH key* to `~/.ssh/authorized_keys` on the device, or
   - **Password** with *Use a key from now on* set to Yes. LiveCompanion installs the key for you and then uses it.
3. If sudo asks for a password, enter it as the *Sudo password* (not needed for root, or for passwordless sudo). Passwords are stored encrypted (AES-256-GCM, key in `/data/secret.key`).
4. Host keys are trusted on first contact and must match afterwards. If a device is reinstalled, use **Trust new key**.

What updates use on the device: `sudo companion-update stable` and `sudo satellite-update stable` (Companion Pi / Satellite Pi installs), `apt-get upgrade` for the OS, and `docker compose pull` + `up -d` for Docker installs. Long jobs run detached on the device, so a dropped connection will not interrupt apt.

### Not updated from here
- Companion 2.x "legacy" installs (the updater asks questions): update once by hand.
- Companion that was not installed with Companion Pi, and containers not started with Docker Compose.
- TrueNAS-managed apps (`.ix-apps`): update them from the TrueNAS Apps screen.
- Non-apt systems: shown, but the OS is not managed.

Docker installs have no config backup (their data lives in the container's volume), and "newer image" is a best-effort comparison of image digests.

## Backups and restore

Backups are in **Settings > Backups** (download) or `/data/backups/<device>/`. Names are `date-time-companion-<version>.tgz`.

To restore Companion on a Companion Pi: stop it, unpack, fix ownership, start it:

```
sudo systemctl stop companion
sudo tar xzf 20261025-033000-companion-v4.2.1.tgz -C /home/companion/.config
sudo chown -R companion:companion /home/companion/.config/companion-nodejs
sudo systemctl start companion
```

Satellite backups hold `satellite-config.json`; unpack with `-C /home/satellite`.

## Security: please read

There is **no login** by default. Anyone who can reach this page can run updates, and reboot devices, as root. Keep it on a trusted network, or set a **Control PIN** (Settings > Settings > Control). With a PIN, every change needs it. Downloading backups needs it too. Stored device passwords can be used to log in to your devices, so protect the `/data` volume.

## Testing status

`npm test` runs 15 tests: version logic, the real probe/update/backup shell scripts against a fake device file tree, the engine's check > backup > update > verify flow and its failure path, mail against a fake SMTP server, and the web API with PIN. The UI was checked in a browser in demo mode.

**Not tested against real hardware.** The real SSH connection (key and password logins, host key handling), real Companion Pi / Satellite updaters, apt, Docker image comparison and the reboot wait could not be run where this was written. Expect some first-run fixes; try it on one non-critical Pi first. Please report what you find.

## Versions

`major.minor.patch` in `package.json`; the GitHub workflow tests, then builds and publishes the image tagged `latest` and with that version on every push to `main`.
