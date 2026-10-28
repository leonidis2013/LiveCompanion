# LiveCompanion

One dashboard for the Bitfocus Companion installs in your building. Add your controllers, Satellites and Docker hosts, see which ones have a newer **stable** Companion / Satellite or operating system updates waiting, and update them from one place. Same look and settings layout as LiveMic and LivePi.

- Adds devices by **network search** or by hand, over **SSH** (key or password).
- Finds out by itself what is on each device: Companion (Companion Pi), Companion Satellite, Companion in Docker, and the OS (apt based: Debian, Ubuntu, Raspberry Pi OS).
- Compares against the newest stable build Bitfocus publishes. Beta builds are never offered.
- Updates one device, one item, or everything at once, always after a confirm window.
- **Backs up the Companion / Satellite configuration to this server before each update.** If the backup fails, nothing is changed. The newest few are kept.
- Shows **Reboot needed** after updates, with a Reboot button, and waits for the device to come back.
- Per device **On/Off switches** (Settings > Devices > Watching) for Companion, Satellite, containers, OS updates and reboot prompts. A Satellite that is installed beside Companion but not running is hidden automatically.
- Checks everything **daily** (default 03:30) and with **Check now**. Badges on the dashboard, plus an optional **email** when something new appears.
- **Development mode** (its own button in the top bar, kept apart from the update pages): lets Claude look inside your central Companion and, when you allow it, program and press its buttons. See below.

## Run it

Docker / Docker Compose:

```
docker compose up -d
```

Open `http://<this machine>:8080`, click the gear, **Devices**.

TrueNAS SCALE: Apps > Discover Apps > Custom App > **Install via YAML**, paste `truenas-app.yaml`, set the dataset path, and give uid 1000 write access to it. Images are built for amd64 and arm64 by the GitHub workflow (`ghcr.io/leonidis2013/livecompanion`).

Without Docker: `node server.js` (Node 22+, no npm packages, needs `ssh` and `ssh-keygen` installed). `node server.js --demo` shows six simulated devices and a simulated Companion for development mode (access token `demo`).

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

## Development mode (Claude)

Development mode connects Claude to **one** Companion, your central one, for building and troubleshooting: Claude can read every page, button, trigger, variable and connection, and, at the level you allow, program and press them. It is the same design as HomeClaude (the Claude bridge for Home Assistant): same permission levels, keep or revert, security and setup guide. It has its own button in the top bar and its own pages (Overview, Connect, Permissions, Security, Backups, Activity); the update dashboard and its settings are not mixed with it. The two share only the control PIN.

**Needs Companion 5.0 or newer.** Nothing is installed in Companion. LiveCompanion talks to the same interface Companion's own admin page uses (its tRPC WebSocket at `/trpc`, plus the export at `/int/export`). That interface is not a published one, so a Companion update can change it; LiveCompanion says plainly when a call stops working.

### Set up

Open **Development mode** (top bar), then **Connect > Open the guide**. Five steps: Companion's address (the admin page address, usually port 8000; your devices that run Companion are offered), what Claude may do, a PIN, and connecting Claude. Then ask Claude: *"Use LiveCompanion to give me an overview of my Companion."*

Claude Code on your network, once:

```
claude mcp add --transport http livecompanion http://<this machine>:9080/mcp --header "Authorization: Bearer <token>"
```

claude.ai, Claude Desktop and the phone app need **exposed mode** (Development mode > Security): a control PIN, a reverse proxy with https (for example a Cloudflare Tunnel) pointed at the **public port 9081** (never at 9080), the public address, and **Test**. Then add a custom connector on claude.ai with `https://<your address>/mcp`. Each sign-in shows a code like `K7Q-2XM`; approve the same code in Development mode, choose a level and an access time (1 hour to no limit), or approve from anywhere with your authenticator app (set it up under Security).

### What Claude may do

| Level | Claude can |
|---|---|
| **Look only** (default) | Read pages and buttons (with their actions, feedbacks and steps), triggers, connections and their status, action and feedback definitions, variables and their values, custom variables, surfaces, the log. |
| **Help build** | Also create and change buttons, copy buttons, add and rename pages, create and change triggers and custom variables. Triggers are saved switched off at this level. |
| **Hands on** | Also press buttons, run triggers, switch triggers and connections on and off, set custom variable values. This acts on the real show. |
| **Full** | Also delete buttons, triggers and custom variables. Only on your network, never from outside. |

- **Protected pages** (Permissions): Claude can read them, but never change, delete or press anything on them, at any level, and buttons or triggers whose actions would press buttons on them are refused (checked on `page/row/column` locations and page numbers in action options).
- **Keep or revert**: each change goes live at once, is backed up, and waits on the Overview with a readable before and after, plus **Keep** and **Revert**. Optionally an unanswered change is reverted (or kept) after 15 minutes to 24 hours. Claude is told what you reverted.
- **Backups** of everything Claude changes or deletes are kept separately from the update backups (Development mode > Backups), with Restore.
- **Activity**: every request Claude made, with errors.
- **Off switch** on the Overview and the Permissions page, handy during a service.

**How a button is written:** Companion has no call to put back a single saved button, so LiveCompanion exports the page as it is, swaps that one button and imports the page again. The rest of the page stays as it was, but the page redraws for a moment, and buttons on it that were part way through their steps start over. Every connection in the import is mapped to the same connection in Companion, so no connection is ever created. Triggers are written through Companion's trigger import and keep their id.

### Security

Same as HomeClaude: the dashboard port refuses anything that came through a proxy, and anything from outside your network, while exposed mode is on; the public port serves only Claude's sign-in and `/mcp` (https and your host name only); OAuth 2.1 with PKCE, approval at home or with an authenticator code, per-connection levels and access times, short-lived rotating tokens stored only as hashes, lockouts after failed attempts, and security events listed under Security. Device and mail passwords, Claude's access token and the authenticator secret are encrypted (AES-256-GCM). Set `LIVECOMPANION_MASTER_KEY` in the app's environment to keep the key off the data volume; LiveCompanion moves everything over and deletes `secret.key`.

## Security: please read

There is **no login** by default. Anyone who can reach this page can run updates, and reboot devices, as root, and can see Claude's access token. Keep it on a trusted network, or set a **Control PIN** (Settings > Settings > Control). With a PIN, every change needs it. Downloading backups needs it too. Stored device passwords can be used to log in to your devices, so protect the `/data` volume.

## Testing status

`npm test` runs 30 tests. 12 are for development mode: the Companion client over a real WebSocket against a pretend Companion 5 (PING/PONG, subscriptions, time-outs, dropped connections, chunked imports with checksums), every tool (reading, building with label and option checks, page-whole writes that leave the rest of the page alone, revert of changes, creations and deletions, restore from backups, protected pages including actions aimed at them, levels, Companion 4 refused), and the whole server (keep or revert, the access token, the off switch, exposed mode keeping the dashboard and the update pages private, sign-in approved at home and with an authenticator code, lockouts). The page was checked in a browser in demo mode on desktop and phone sizes. The other 18: version logic, the real probe/update/backup shell scripts against a fake device file tree, the engine's check > backup > update > verify flow and its failure path, mail against a fake SMTP server, and the web API with PIN. The UI was checked in a browser in demo mode.

**Development mode was not tested against a real Companion.** It was written from Companion 5.1.1's source, and the pretend Companion answers the way that source does, but expect some first-run fixes; try Look only first, then Help build on a page you do not use on Sundays.

**The update side was not tested against real hardware either.** The real SSH connection (key and password logins, host key handling), real Companion Pi / Satellite updaters, apt, Docker image comparison and the reboot wait could not be run where this was written. Expect some first-run fixes; try it on one non-critical Pi first. Please report what you find.

## Versions

`major.minor.patch` in `package.json`; the GitHub workflow tests, then builds and publishes the image tagged `latest` and with that version on every push to `main`.
