#!/usr/bin/env bash
# MowBot installer and updater, for a Linux server (Ubuntu, Debian, Fedora…).
#
#   sudo ./install.sh        install, or update an existing install: same command
#   sudo mowbot update       the same, once installed
#   sudo mowbot status | logs [service] | start | stop | restart
#
# Installs Docker when missing, writes deploy/.env on the first run (address, generated keys),
# builds the images (hub, web, the bots' computers) and starts the stack. Running it again pulls
# the code, rebuilds and restarts: deploy/.env and all data (Docker volumes) stay.
set -Eeuo pipefail

REPO_URL=${MOWBOT_REPO:-https://github.com/getmowbot/MowBot.git}
BRANCH=${MOWBOT_BRANCH:-main}
DEFAULT_DIR=/opt/mowbot
# The computers mount one sub-folder of the workspaces volume (Docker API 1.45).
MIN_DOCKER=26

if [[ -t 1 ]]; then
  b=$'\e[1m' red=$'\e[31m' yellow=$'\e[33m' green=$'\e[32m' off=$'\e[0m'
else
  b='' red='' yellow='' green='' off=''
fi
step() { printf '\n%s==> %s%s\n' "$b" "$*" "$off"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '%s    ! %s%s\n' "$yellow" "$*" "$off" >&2; }
die() {
  printf '%sErreur : %s%s\n' "$red" "$*" "$off" >&2
  exit 1
}

usage() {
  cat <<'EOF'
MowBot : installation et mise à jour sur un serveur Linux.

  sudo ./install.sh [options]     installe MowBot, ou le met à jour s'il est déjà installé
  sudo mowbot update              met à jour (code, images, redémarrage)
  sudo mowbot status              état des services et adresse
  sudo mowbot logs [service]      journaux en direct (hub, caddy, postgres…)
  sudo mowbot start | stop | restart

Options de la première installation :
  --domain NOM    nom de domaine public, servi en HTTPS (certificat Let's Encrypt)
  --lan           réseau local en HTTP, sans question
  --port PORT     port HTTP en réseau local (80 par défaut)
  --dir DOSSIER   dossier d'installation quand le script ne tourne pas depuis le dépôt
                  (/opt/mowbot par défaut)
  -y, --yes       accepte les choix par défaut sans poser de question
EOF
}

command=install
dir=''
domain=''
lan=0
http_port=''
assume_yes=0
services=()
args=()
self=''
env_file=''
compose_file=''
tty=''

parse_args() {
  while (($#)); do
    case $1 in
      install | update | status | logs | start | stop | restart | help) command=$1 ;;
      --domain)
        domain=${2:?--domain attend un nom}
        shift
        ;;
      --lan) lan=1 ;;
      --port)
        http_port=${2:?--port attend un numéro}
        shift
        ;;
      --dir)
        dir=${2:?--dir attend un dossier}
        shift
        ;;
      -y | --yes) assume_yes=1 ;;
      -h | --help) command=help ;;
      *)
        [[ $command == logs && $1 != -* ]] || die "option inconnue : $1 (voir --help)"
        services+=("$1")
        ;;
    esac
    shift
  done
}

# ask <question> <default>: prints the answer.
ask() {
  local reply=''
  if ((assume_yes)) || [[ -z $tty ]]; then
    printf '%s\n' "$2"
    return
  fi
  read -r -p "    $1" reply <"$tty" || true
  printf '%s\n' "${reply:-$2}"
}

# confirm <question> <y|n>: yes or no, the default when nobody answers.
confirm() {
  local reply
  if [[ $2 == y ]]; then
    reply=$(ask "$1 [O/n] " o)
  else
    reply=$(ask "$1 [o/N] " n)
  fi
  [[ $reply =~ ^[oOyY] ]]
}

random() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

env_get() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }

# set_env <file> <key> <value>: replaces the key's line, or adds it.
set_env() {
  local tmp
  tmp=$(mktemp)
  awk -v key="$2" -v value="$3" '
    index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$1" >"$tmp"
  cat "$tmp" >"$1"
  rm -f "$tmp"
}

compose() { docker compose -f "$compose_file" --env-file "$env_file" "$@"; }

# The repository as its owner: their SSH key pulls a private repository, files stay theirs.
git_repo() {
  local owner
  owner=$(stat -c %U "$dir")
  if [[ $owner != root ]] && command -v sudo >/dev/null; then
    sudo -H -u "$owner" --preserve-env=SSH_AUTH_SOCK git -C "$dir" "$@"
  else
    git -c safe.directory="$dir" -C "$dir" "$@"
  fi
}

lan_ip() {
  local ip=''
  if command -v ip >/dev/null; then
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  fi
  [[ -n $ip ]] || ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
  printf '%s\n' "${ip:-localhost}"
}

port_busy() {
  command -v ss >/dev/null || return 1
  [[ -n $(ss -Hltn "sport = :$1" 2>/dev/null) ]]
}

# The first free port from $1 on.
free_port() {
  local port=$1
  while port_busy "$port"; do port=$((port + 1)); done
  printf '%s\n' "$port"
}

public_url() {
  local address port https url
  address=$(env_get MOWBOT_DOMAIN)
  address=${address%%,*}
  address=${address// /}
  port=$(env_get MOWBOT_HTTP_PORT)
  https=$(env_get MOWBOT_HTTPS_PORT)
  case $address in
    '' | :*)
      url="http://$(lan_ip)"
      [[ ${port:-80} == 80 ]] || url+=":$port"
      ;;
    http://*)
      url=$address
      [[ ${port:-80} == 80 ]] || url+=":$port"
      ;;
    *)
      url="https://${address#https://}"
      [[ ${https:-443} == 443 ]] || url+=":$https"
      ;;
  esac
  printf '%s\n' "$url"
}

# ---------------------------------------------------------------------------------------------
# Installation

pkg_install() {
  if command -v apt-get >/dev/null; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null; then
    dnf install -y -q "$@"
  elif command -v yum >/dev/null; then
    yum install -y -q "$@"
  elif command -v pacman >/dev/null; then
    pacman -Sy --noconfirm "$@"
  else
    return 1
  fi
}

# need <command> <package>
need() {
  command -v "$1" >/dev/null && return
  note "Installation de $1"
  pkg_install "$2" >/dev/null || die "installe $1 puis relance."
}

docker_up() { docker info >/dev/null 2>&1; }

start_docker() {
  if [[ -d /run/systemd/system ]]; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  else
    service docker start >/dev/null 2>&1 || true
  fi
  local _
  for _ in $(seq 30); do
    docker_up && return
    sleep 1
  done
  die "Docker ne démarre pas (voir : systemctl status docker)."
}

setup_docker() {
  if ! command -v docker >/dev/null; then
    step "Installation de Docker"
    confirm "Docker n'est pas installé. L'installer avec le script officiel (get.docker.com) ?" y ||
      die "installe Docker puis relance."
    curl -fsSL https://get.docker.com | sh
  fi
  docker_up || start_docker
  local version major
  version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  major=${version%%.*}
  [[ $major =~ ^[0-9]+$ ]] || major=0
  ((major >= MIN_DOCKER)) ||
    die "Docker ${version:-?} est trop ancien : il faut Docker $MIN_DOCKER ou plus récent."
  if ! docker compose version >/dev/null 2>&1; then
    note "Installation de Docker Compose"
    pkg_install docker-compose-plugin >/dev/null 2>&1 ||
      die "installe le plugin Docker Compose (commande « docker compose ») puis relance."
  fi
  if ! docker buildx version >/dev/null 2>&1; then
    pkg_install docker-buildx-plugin >/dev/null 2>&1 ||
      warn "plugin Docker buildx absent : la construction des images peut échouer."
  fi
}

sync_code() {
  if [[ ! -e $dir/.git ]]; then
    [[ -z $(ls -A "$dir" 2>/dev/null) ]] || die "$dir existe déjà et n'est pas un dépôt MowBot."
    step "Téléchargement de MowBot dans $dir"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$dir" ||
      die "impossible de cloner $REPO_URL. Si le dépôt est privé, clone-le avec ta clé SSH puis lance install.sh depuis ce dossier."
    return
  fi
  step "Mise à jour du code"
  local branch before after
  if ! branch=$(git_repo symbolic-ref --quiet --short HEAD); then
    warn "pas sur une branche (HEAD détachée) : le code reste tel quel."
    return
  fi
  if [[ -n $(git_repo status --porcelain --untracked-files=no) ]]; then
    warn "modifications locales dans $dir : le code reste tel quel."
    return
  fi
  before=$(git_repo rev-parse HEAD)
  git_repo pull --ff-only --quiet || die "git pull a échoué dans $dir."
  after=$(git_repo rev-parse HEAD)
  if [[ $before == "$after" ]]; then
    note "Déjà à jour (${after:0:7}, branche $branch)."
  else
    note "${before:0:7} → ${after:0:7} :"
    git_repo log --oneline --no-decorate -n 15 "$before..$after" | sed 's/^/      /'
  fi
}

check_machine() {
  local arch memory disk root
  arch=$(uname -m)
  [[ $arch == x86_64 ]] ||
    warn "processeur $arch : Google Chrome n'existe qu'en x86_64, les PC des bots n'auront pas de navigateur."
  memory=$(awk '/^MemTotal/ { print int($2 / 1048576 + 0.5) }' /proc/meminfo)
  ((memory >= 4)) ||
    warn "$memory Go de RAM : compte au moins 4 Go, plus 2 à 4 Go par PC de bot allumé."
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)
  disk=$(df -Pk "$root" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')
  ((${disk:-0} >= 20)) ||
    warn "${disk:-?} Go libres pour Docker : les images et les PC des bots demandent au moins 20 Go."
}

# First run: deploy/.env from the example, with the address and fresh keys.
configure() {
  step "Configuration"
  check_machine
  local file=$env_file.new ip port https cookie=true
  ip=$(lan_ip)
  if [[ -z $domain ]] && ((!lan && !assume_yes)) && [[ -n $tty ]]; then
    note "MowBot peut être servi :"
    note "  • sur ton réseau local, en HTTP : http://$ip"
    note "  • sur un nom de domaine public, en HTTPS avec un certificat automatique : le domaine"
    note "    doit pointer vers ce serveur, ports 80 et 443 ouverts depuis internet."
    domain=$(ask "Nom de domaine (vide = réseau local) : " "")
  fi
  domain=${domain// /}
  if [[ -n $domain ]]; then
    domain=${domain#https://}
    domain=${domain%/}
    [[ $domain != http://* ]] || cookie=false
    for port in 80 443; do
      if port_busy "$port"; then
        warn "le port $port est déjà utilisé : le certificat et MowBot en ont besoin."
        confirm "Continuer quand même ?" n || die "libère le port $port puis relance."
      fi
    done
    port=80
    https=443
  else
    domain=':80' # every address of the server, plain HTTP
    cookie=false
    port=${http_port:-80}
    if port_busy "$port"; then
      warn "le port $port est déjà utilisé."
      port=$(ask "Port HTTP pour MowBot : " "$(free_port 8080)")
    fi
    # Unused in plain HTTP, but published: keep clear of a web server already there.
    https=443
    if port_busy "$https"; then https=$(free_port 8443); fi
  fi

  cp "$dir/deploy/.env.example" "$file"
  chmod 600 "$file"
  set_env "$file" MOWBOT_DOMAIN "$domain"
  set_env "$file" MOWBOT_COOKIE_SECURE "$cookie"
  set_env "$file" MOWBOT_HTTP_PORT "$port"
  set_env "$file" MOWBOT_HTTPS_PORT "$https"
  set_env "$file" POSTGRES_PASSWORD "$(random 24 | tr -d '+/=')"
  set_env "$file" MOWBOT_MASTER_KEY "$(random 32)"
  set_env "$file" MOWBOT_SETUP_TOKEN "$(random 18 | tr '+/' '-_')"
  mv "$file" "$env_file"
  note "Réglages écrits dans $env_file"
}

# Updates: settings the new version introduced get their default.
add_new_settings() {
  local line key added=()
  [[ -z $(tail -c 1 "$env_file") ]] || printf '\n' >>"$env_file"
  while IFS= read -r line; do
    [[ $line =~ ^([A-Z0-9_]+)= ]] || continue
    key=${BASH_REMATCH[1]}
    grep -q "^$key=" "$env_file" && continue
    printf '%s\n' "$line" >>"$env_file"
    added+=("$key")
  done <"$dir/deploy/.env.example"
  if ((${#added[@]})); then note "Nouveaux réglages dans deploy/.env : ${added[*]}"; fi
}

wait_hub() {
  local id status _
  id=$(compose ps -q hub)
  for _ in $(seq 90); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)
    [[ $status == healthy ]] && return 0
    sleep 2
  done
  warn "le hub ne répond pas encore. Ses journaux : sudo mowbot logs hub"
  return 1
}

deploy() {
  step "Construction des images"
  if [[ -z $(docker images -q "$(env_get MOWBOT_WORKSTATION_IMAGE)" 2>/dev/null) ]]; then
    note "La première fois : 10 à 20 minutes (le PC des bots embarque Ubuntu, un bureau et Chrome)."
  fi
  # Without attestations, an unchanged image keeps its id: nothing restarts for nothing.
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 compose --profile build build
  step "Démarrage"
  compose pull --quiet --ignore-buildable 2>/dev/null || true
  compose up -d --remove-orphans
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  wait_hub
}

summary() {
  local url setup token
  url=$(public_url)
  setup=$(compose exec -T hub node -e "fetch('http://127.0.0.1:8787/api/v1/auth/status').then((r) => r.json()).then((s) => console.log(s.setupRequired))" 2>/dev/null || true)
  printf '\n%s%sMowBot tourne : %s%s\n' "$green" "$b" "$url" "$off"
  if [[ $setup == true ]]; then
    token=$(env_get MOWBOT_SETUP_TOKEN)
    if [[ -z $token ]]; then
      token=$(compose logs hub 2>/dev/null | grep -o 'setup token: [A-Za-z0-9_-]*' | tail -n 1 | cut -d ' ' -f 3 || true)
    fi
    note "Ouvre-le et crée ton compte avec le jeton de configuration : $b${token:-voir sudo mowbot logs hub}$off"
  fi
  note "App mobile : adresse du hub $url"
  note "Garde une copie de $env_file : sa clé MOWBOT_MASTER_KEY chiffre les secrets."
  note "Mettre à jour : sudo mowbot update · état : sudo mowbot status · journaux : sudo mowbot logs"
}

script_sum() {
  if [[ -f $dir/install.sh ]]; then sha256sum "$dir/install.sh" | cut -d ' ' -f 1; fi
}

install_or_update() {
  if [[ -z ${MOWBOT_REEXEC:-} ]]; then
    step "Prérequis"
    need curl curl
    need git git
    setup_docker
    note "Docker $(docker version --format '{{.Server.Version}}'), Compose $(docker compose version --short 2>/dev/null || echo '?')"
    local before
    before=$(script_sum)
    sync_code
    # Carry on with the installer of the code just fetched: piped from curl, or updated.
    if [[ $self != "$dir/install.sh" || $(script_sum) != "$before" ]]; then
      MOWBOT_REEXEC=1 exec bash "$dir/install.sh" --dir "$dir" "${args[@]}"
    fi
  fi

  if [[ -f $env_file ]]; then add_new_settings; else configure; fi
  deploy
  if [[ -d /usr/local/bin ]]; then ln -sfn "$dir/install.sh" /usr/local/bin/mowbot; fi
  summary
}

installed() { [[ -f $env_file ]] || die "MowBot n'est pas installé dans $dir (lance install.sh)."; }

main() {
  args=("$@")
  parse_args "$@"
  if [[ $command == help ]]; then
    usage
    return
  fi

  # This script as a file (empty when piped into bash).
  self=${BASH_SOURCE[0]:-}
  if [[ -n $self && -f $self ]]; then self=$(readlink -f "$self"); else self=''; fi

  if ((EUID != 0)); then
    [[ -n $self ]] || die "lance-le avec sudo (… | sudo bash)."
    exec sudo --preserve-env=SSH_AUTH_SOCK,MOWBOT_REPO,MOWBOT_BRANCH bash "$self" "${args[@]}"
  fi

  if [[ -z $dir ]]; then
    if [[ -n $self && -f $(dirname "$self")/deploy/docker-compose.yml ]]; then
      dir=$(dirname "$self")
    else
      dir=$DEFAULT_DIR
    fi
  fi
  dir=$(readlink -m "$dir")
  env_file=$dir/deploy/.env
  compose_file=$dir/deploy/docker-compose.yml

  # Questions read the terminal, even when the script itself comes through a pipe.
  if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then tty=/dev/tty; fi

  case $command in
    install | update) install_or_update ;;
    status)
      installed
      compose ps
      note "Adresse : $(public_url)"
      ;;
    logs)
      installed
      compose logs -f --tail=200 "${services[@]}"
      ;;
    start)
      installed
      compose up -d
      wait_hub
      note "MowBot tourne : $(public_url)"
      ;;
    stop)
      installed
      compose stop
      # The bots' computers run beside the stack: stop them too (the hub restarts them on demand).
      local computers
      mapfile -t computers < <(docker ps -q --filter label=dev.mowbot.computer)
      if ((${#computers[@]})); then docker stop "${computers[@]}" >/dev/null; fi
      note "MowBot est arrêté (sudo mowbot start pour le relancer)."
      ;;
    restart)
      installed
      compose restart
      wait_hub
      note "MowBot tourne : $(public_url)"
      ;;
  esac
}

# Last line: piped into bash, the whole script is read before anything runs.
main "$@"
