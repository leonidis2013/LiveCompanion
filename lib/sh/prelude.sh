# LiveCompanion: shared start of every script that runs on a device.
# LC_ROOT is empty on real devices; the tests point it at a fake file tree.
R="${LC_ROOT:-}"
PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin"; export PATH
PW="${LC_PWV:-}"
kv() { printf '%s=%s\n' "$1" "$2"; }
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif [ -n "$PW" ]; then printf '%s\n' "$PW" | sudo -S -p '' "$@"
  else sudo -n "$@"
  fi
}
