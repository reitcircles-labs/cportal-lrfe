#!/bin/sh
# Run this on your laptop: forwards ports from the server to your laptop over one SSH connection,
# so http://localhost:<port> on the laptop reaches 127.0.0.1:<port> on the server.
#
#   ./remoteConnect.sh 4200 3510            the app (ng serve) and the API docs
#   ./remoteConnect.sh 8080:4200            laptop port 8080 → server port 4200 (when 4200 is busy locally)
#   ./remoteConnect.sh --setup              create the config file, then edit it
#
# Ports used by this project on the server:
#   4200 frontend (ng serve; it forwards /api to the gateway itself, so 4200 alone runs the app)
#   3500 gateway   3501 identity   3502 edrms   3503 bpm   3504 intake   3510 API docs (Swagger UI)
#
# The server address and its host key live in a config file on the laptop, never in the repo:
#   ${XDG_CONFIG_HOME:-~/.config}/remote-connect/config      (see scripts/README.md)
# Environment variables of the same names (REMOTE, SSH_PORT, SSH_KEY, HOST_KEY) override it.
# DRY_RUN=1 prints the ssh command instead of running it.
#
# Security: forwarded ports are bound to 127.0.0.1 on the laptop only; the server's host key is
# pinned (no trust-on-first-use, no silent acceptance of a changed key); only the named key is
# offered; no agent or X11 forwarding; the key file must be private.

CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/remote-connect
CONFIG=$CONFIG_DIR/config

usage() {
    echo "Usage: $0 PORT [PORT ...]     (a PORT is 4200, or LAPTOP_PORT:SERVER_PORT such as 8080:4200)"
    echo "       $0 --setup             create $CONFIG to fill in"
    echo "Example: $0 4200 3510         the app and the API docs"
}

fail() { echo "$*" >&2; exit 1; }

if [ "$1" = "--setup" ]; then
    [ -e "$CONFIG" ] && fail "$CONFIG already exists; edit it."
    mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR" || fail "Cannot create $CONFIG_DIR"
    umask 077
    cat > "$CONFIG" <<'EOF'
# remoteConnect.sh settings (this file stays on your laptop). Ask the server's administrator for the values.
REMOTE=user@server-address
SSH_PORT=22
SSH_KEY=~/.ssh/id_rsa
# The server's public host key, one line: "ssh-ed25519 AAAA...". Get it from the administrator
# over a trusted channel (not over the connection you are about to secure).
HOST_KEY=
EOF
    echo "Created $CONFIG; fill in REMOTE, SSH_PORT, SSH_KEY and HOST_KEY."
    exit 0
fi

# ---------------------------------------------------------------- settings
# The config is read as KEY=VALUE lines, never executed. Environment variables win.

config_value() {
    [ -f "$CONFIG" ] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONFIG" | tail -n 1 | sed 's/[[:space:]]*$//'
}
REMOTE=${REMOTE:-$(config_value REMOTE)}
SSH_PORT=${SSH_PORT:-$(config_value SSH_PORT)}
SSH_PORT=${SSH_PORT:-22}
SSH_KEY=${SSH_KEY:-$(config_value SSH_KEY)}
HOST_KEY=${HOST_KEY:-$(config_value HOST_KEY)}
case $SSH_KEY in "~/"*) SSH_KEY=$HOME/${SSH_KEY#"~/"} ;; esac

[ $# -eq 0 ] && { echo "No ports given. Please give the port number(s) to connect to."; usage; exit 1; }

[ -n "$REMOTE" ] && [ "$REMOTE" != "user@server-address" ] || fail "No server configured. Run: $0 --setup   (or set REMOTE)"
case $REMOTE in
    *@*) host=${REMOTE#*@} ;;
    *) fail "REMOTE must look like user@host, got: $REMOTE" ;;
esac
case $REMOTE in *[!A-Za-z0-9@._-]*) fail "REMOTE contains characters that are not allowed: $REMOTE" ;; esac

is_port() {
    case $1 in ''|*[!0-9]*) return 1 ;; esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
is_port "$SSH_PORT" || fail "SSH_PORT is not a port: $SSH_PORT"

# ---------------------------------------------------------------- key

[ -n "$SSH_KEY" ] || fail "No SSH key configured (SSH_KEY in $CONFIG)"
[ -f "$SSH_KEY" ] || fail "SSH key not found: $SSH_KEY"
# private keys must not be readable by anyone else (ssh refuses them too, less clearly)
case $(ls -l "$SSH_KEY" | cut -c5-10) in
    ------) ;;
    *) fail "SSH key $SSH_KEY can be read by other users. Fix it with: chmod 600 \"$SSH_KEY\"" ;;
esac

# ---------------------------------------------------------------- host key pinning

case $HOST_KEY in
    ssh-ed25519\ *|ecdsa-sha2-*\ *|ssh-rsa\ *) ;;
    '') fail "No HOST_KEY configured: without it a man-in-the-middle could pose as the server. Add the server's public host key to $CONFIG" ;;
    *) fail "HOST_KEY does not look like a public host key (\"ssh-ed25519 AAAA...\")" ;;
esac
mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
KNOWN_HOSTS=$CONFIG_DIR/known_hosts
if [ "$SSH_PORT" = 22 ]; then entry=$host; else entry="[$host]:$SSH_PORT"; fi
(umask 077; echo "$entry $HOST_KEY" > "$KNOWN_HOSTS") || fail "Cannot write $KNOWN_HOSTS"

# ---------------------------------------------------------------- ports

FORWARDS=""
URLS=""
for arg in "$@"; do
    case $arg in
        *:*) local_port=${arg%%:*}; remote_port=${arg#*:} ;;
        *) local_port=$arg; remote_port=$arg ;;
    esac
    if ! is_port "$local_port" || ! is_port "$remote_port"; then
        echo "Not a valid port: $arg"
        usage
        exit 1
    fi
    # below 1024 the laptop would need root (sudo) to listen; never run this script as root
    [ "$local_port" -ge 1024 ] || fail "Laptop port $local_port is below 1024; use e.g. 8080:$remote_port instead"
    case " $URLS " in
        *" http://localhost:$local_port "*) fail "Laptop port $local_port is given twice" ;;
    esac
    # 127.0.0.1 on both ends: only this laptop can use the forward, and it reaches only the server's
    # loopback services (whatever GatewayPorts says in the laptop's ssh config)
    FORWARDS="$FORWARDS -L 127.0.0.1:$local_port:127.0.0.1:$remote_port"
    URLS="$URLS http://localhost:$local_port"
done

[ "$(id -u)" != 0 ] || fail "Do not run this as root."

# ---------------------------------------------------------------- connect

# $FORWARDS is unquoted on purpose: it holds several "-L ..." arguments (validated digits only).
set -- ssh -i "$SSH_KEY" -p "$SSH_PORT" -N \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no \
    -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o GatewayPorts=no \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    $FORWARDS "$REMOTE"

if [ -n "$DRY_RUN" ]; then
    echo "$@"
    exit 0
fi

echo "Connecting to $REMOTE. Once connected, browse to:"
for url in $URLS; do echo "  $url"; done
echo "Keep this window open; Ctrl+C disconnects."
exec "$@"
