#!/bin/sh
# Installs (or updates) the MowBot desktop app on Linux, for the current user.
#
#   curl -fsSL https://raw.githubusercontent.com/jorisleva/MowBot/main/apps/desktop/install-linux.sh \
#     | sh -s -- --hub https://mowbot.example.com
#
# --hub <address>  the hub the app connects to (the web interface's address); without it, the app
#                  asks on its first launch.
# GITHUB_TOKEN     needed while the repository is private (a token that can read it).
set -eu

REPO="${MOWBOT_REPO:-jorisleva/MowBot}"
HUB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --hub=*) HUB="${1#--hub=}"; shift ;;
    -h | --help)
      sed -n '2,10p' "$0" 2>/dev/null || true
      exit 0
      ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'Erreur : %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl est requis."
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) fail "seuls les PC x86_64 ont une version Linux pour l'instant." ;;
esac

api() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' "$@"
  else
    curl -fsSL -H 'Accept: application/vnd.github+json' "$@"
  fi
}

say "Recherche de la dernière version de MowBot desktop…"
RELEASES="$(api "https://api.github.com/repos/$REPO/releases?per_page=20")" ||
  fail "impossible de lire les versions de $REPO (dépôt privé ? définis GITHUB_TOKEN)."
# The newest published release with an AppImage: its asset's API URL (works for private repos).
ASSET_URL="$(printf '%s' "$RELEASES" | tr ',' '\n' |
  grep -E '"url": *"https://api.github.com/repos/[^"]+/releases/assets/[0-9]+"|"name": *"[^"]+\.AppImage"' |
  grep -B1 -E '\.AppImage"' | grep -oE 'https://api.github.com/repos/[^"]+/releases/assets/[0-9]+' | head -n 1)"
[ -n "$ASSET_URL" ] || fail "aucune version Linux (AppImage) publiée pour l'instant."

BIN_DIR="$HOME/.local/bin"
APP="$BIN_DIR/mowbot-desktop"
mkdir -p "$BIN_DIR" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/128x128/apps"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
say "Téléchargement…"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  curl -fL --progress-bar -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/octet-stream' -o "$TMP" "$ASSET_URL"
else
  curl -fL --progress-bar -H 'Accept: application/octet-stream' -o "$TMP" "$ASSET_URL"
fi
chmod +x "$TMP"
mv "$TMP" "$APP"
trap - EXIT

ICON_URL="https://raw.githubusercontent.com/$REPO/main/apps/desktop/src-tauri/icons/128x128.png"
ICON="$HOME/.local/share/icons/hicolor/128x128/apps/mowbot.png"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -o "$ICON" "$ICON_URL" || true
else
  curl -fsSL -o "$ICON" "$ICON_URL" || true
fi
cat >"$HOME/.local/share/applications/mowbot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MowBot
Comment=Tes équipes de bots, et les dossiers que tu leur partages
Exec=$APP %U
Icon=mowbot
Terminal=false
Categories=Office;Development;
EOF

say "MowBot desktop est installé : $APP"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Ajoute $BIN_DIR à ton PATH pour le lancer depuis un terminal." ;;
esac
if [ -n "$HUB" ]; then
  # The app saves the hub given with --hub, then keeps running (icon in the tray).
  nohup "$APP" --hub "$HUB" >/dev/null 2>&1 &
  say "Lancée sur $HUB."
else
  echo "Lance « MowBot » depuis tes applications : il te demandera l'adresse de ton hub."
fi
