# LiveCompanion probe: what is on this device and what is out of date.
# Read-only, except that it refreshes the package lists when LC_REFRESH=1.
kv lc_probe 1
kv user "$(id -un 2>/dev/null)"
kv uid "$(id -u)"
if [ "$(id -u)" -eq 0 ]; then
  kv sudo 1
elif [ -n "$PW" ]; then
  if printf '%s\n' "$PW" | sudo -S -p '' true >/dev/null 2>&1; then kv sudo 1; else kv sudo 0; fi
else
  if sudo -n true >/dev/null 2>&1; then kv sudo 1; else kv sudo 0; fi
fi
kv hostname "$(hostname 2>/dev/null || cat "$R/etc/hostname" 2>/dev/null)"
kv arch "$(uname -m)"
kv kernel "$(uname -r)"
kv boot_id "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
kv uptime "$(cut -d. -f1 /proc/uptime 2>/dev/null)"
if [ -r "$R/etc/os-release" ]; then
  ( . "$R/etc/os-release"; kv os "$PRETTY_NAME"; kv os_id "$ID"; kv os_ver "$VERSION_ID" )
fi

# ---- reboot needed? ----
if [ -f "$R/var/run/reboot-required" ] || [ -f "$R/run/reboot-required" ]; then
  kv reboot_required 1
  kv reboot_why "file"
  kv reboot_pkgs "$(sort -u "$R/var/run/reboot-required.pkgs" "$R/run/reboot-required.pkgs" 2>/dev/null | head -5 | tr '\n' ',')"
elif [ -d "$R/lib/modules" ] && [ ! -d "$R/lib/modules/$(uname -r)" ]; then
  kv reboot_required 1
  kv reboot_why "kernel"
else
  kv reboot_required 0
fi

# ---- operating system updates (Debian, Ubuntu, Raspberry Pi OS) ----
if command -v apt-get >/dev/null 2>&1; then
  kv pkg_mgr apt
  if [ "${LC_REFRESH:-0}" = 1 ]; then
    if as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1; then kv apt_refreshed 1; else kv apt_refreshed 0; fi
  fi
  stamp=0
  for f in "$R/var/lib/apt/periodic/update-success-stamp" "$R/var/lib/apt/lists"; do
    if [ -e "$f" ]; then t=$(stat -c %Y "$f" 2>/dev/null || echo 0); [ "$t" -gt "$stamp" ] && stamp=$t; fi
  done
  if [ "$stamp" -gt 0 ]; then kv apt_lists_age "$(( $(date +%s) - stamp ))"; fi
  sim=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null)
  kv apt_count "$(printf '%s\n' "$sim" | grep -c '^Inst ')"
  kv apt_security "$(printf '%s\n' "$sim" | grep '^Inst ' | grep -c -i 'security')"
  kv apt_kept "$(printf '%s\n' "$sim" | sed -n 's/.* \([0-9][0-9]*\) not upgraded.*/\1/p' | head -1)"
  kv apt_pkgs "$(printf '%s\n' "$sim" | awk '/^Inst /{print $2}' | head -12 | tr '\n' ',')"
else
  kv pkg_mgr none
fi

# ---- Companion (controller), installed with Companion Pi ----
if [ -f "$R/opt/companion/BUILD" ] || [ -d "$R/usr/local/src/companionpi" ] || [ -d "$R/usr/local/src/companion" ]; then
  kv companion_present 1
  kv companion_build "$(head -1 "$R/opt/companion/BUILD" 2>/dev/null)"
  if [ -d "$R/usr/local/src/companionpi" ]; then kv companion_managed 1; else kv companion_managed 0; fi
  if [ -d "$R/usr/local/src/companion" ]; then kv companion_legacy 1; fi
  kv companion_service "$(systemctl is-active companion 2>/dev/null)"
  kv companion_port "$(sed -n 's/^[[:space:]]*adminPort:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$R/etc/companion/config.yaml" 2>/dev/null | head -1)"
  if [ -d "$R/home/companion/.config/companion-nodejs" ]; then kv companion_cfg "/home/companion/.config/companion-nodejs"
  elif [ -d "$R/home/companion/companion" ]; then kv companion_cfg "/home/companion/companion"; fi
fi

# ---- Companion Satellite ----
if [ -d "$R/opt/companion-satellite" ] || [ -d "$R/usr/local/src/companion-satellite" ]; then
  kv satellite_present 1
  kv satellite_build "$(head -1 "$R/opt/companion-satellite/BUILD" 2>/dev/null)"
  if [ -d "$R/usr/local/src/companion-satellite" ]; then kv satellite_managed 1; else kv satellite_managed 0; fi
  kv satellite_service "$(systemctl is-active satellite 2>/dev/null)"
  kv satellite_port "$(sed -n 's/.*"httpPort"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$R/home/satellite/satellite-config.json" 2>/dev/null | head -1)"
  if [ -f "$R/home/satellite/satellite-config.json" ]; then kv satellite_cfg "/home/satellite/satellite-config.json"; fi
fi

# ---- Companion or Satellite running in Docker ----
if command -v docker >/dev/null 2>&1; then
  dk=docker
  if ! docker ps >/dev/null 2>&1; then
    dk=''
    if as_root docker ps >/dev/null 2>&1; then dk='as_root docker'; fi
  fi
  if [ -n "$dk" ]; then
    kv docker_ok 1
    $dk ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null \
      | grep -i -E '\|[^|]*(bitfocus/companion|companion-satellite)[^|]*\|' | head -10 \
      | while IFS='|' read -r cid cname cimage cstate cwd csvc; do
          ver=$($dk inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$cid" 2>/dev/null)
          iid=$($dk inspect -f '{{.Image}}' "$cid" 2>/dev/null)
          rdig=$($dk image inspect -f '{{join .RepoDigests ","}}' "$iid" 2>/dev/null)
          remote=''
          if [ "${LC_REFRESH:-0}" = 1 ]; then
            remote=$($dk buildx imagetools inspect "$cimage" --raw 2>/dev/null | sha256sum 2>/dev/null | cut -d' ' -f1)
          fi
          kv docker "$cid|$cname|$cimage|$cstate|$cwd|$csvc|$ver|$rdig|$remote"
        done
  else
    kv docker_ok 0
  fi
fi
kv lc_done 1
