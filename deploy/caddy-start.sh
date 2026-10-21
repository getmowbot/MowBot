#!/bin/sh
# Entry point of the Caddy image. Writes /etc/caddy/previews.caddy, the sites of the bots' web
# previews (imported by the Caddyfile): each port of MOWBOT_PREVIEW_PORTS, on every address of
# MOWBOT_DOMAIN, proxied to the same port of the hub. Then starts Caddy.
#
# A domain or a LAN name keeps its certificate on these ports (HTTPS); a plain HTTP address
# (`:80`, `http://…`) serves them in plain HTTP. With a mix of both, previews are plain HTTP.
set -eu

out=${MOWBOT_PREVIEWS_FILE:-/etc/caddy/previews.caddy}
range=${MOWBOT_PREVIEW_PORTS:-8800-8819}
domains=${MOWBOT_DOMAIN:-localhost}

# `host:port` → host (a site address may carry the main port).
host_of() {
  host=${1#http://}
  host=${host#https://}
  case $host in
    \[*\]*) printf '%s\n' "${host%%]*}]" ;; # [IPv6]
    *) printf '%s\n' "${host%%:*}" ;;
  esac
}

plain=0
everywhere=0
old_ifs=$IFS
IFS=','
for address in $domains; do
  address=$(printf '%s' "$address" | tr -d ' ')
  case $address in
    :*) plain=1 everywhere=1 ;;
    http://*) plain=1 ;;
  esac
done
IFS=$old_ifs

# The sites of one port, comma-separated.
sites_for() {
  if [ "$everywhere" = 1 ]; then
    printf 'http://:%s\n' "$1"
    return
  fi
  list=''
  IFS=','
  for address in $domains; do
    address=$(printf '%s' "$address" | tr -d ' ')
    [ -n "$address" ] || continue
    host=$(host_of "$address")
    if [ "$plain" = 1 ]; then site="http://$host:$1"; else site="$host:$1"; fi
    list="${list:+$list, }$site"
  done
  IFS=$old_ifs
  printf '%s\n' "$list"
}

{
  echo "# Written at startup from MOWBOT_PREVIEW_PORTS=$range and MOWBOT_DOMAIN (caddy-start.sh)."
  case $range in
    off | '') ;;
    *[!0-9-]* | -* | *-*-*)
      echo "caddy-start: MOWBOT_PREVIEW_PORTS must be a port or a range like 8800-8819" >&2
      exit 1
      ;;
    *)
      first=${range%-*}
      last=${range#*-}
      port=$first
      while [ "$port" -le "$last" ]; do
        # The bot's page itself: no compression or headers of the hub's site here, the hub
        # filters what the page may send (see apps/hub/src/previews).
        printf '%s {\n\treverse_proxy hub:%s\n}\n' "$(sites_for "$port")" "$port"
        port=$((port + 1))
      done
      ;;
  esac
} >"$out"

[ -n "${MOWBOT_PREVIEWS_ONLY:-}" ] && exit 0
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
