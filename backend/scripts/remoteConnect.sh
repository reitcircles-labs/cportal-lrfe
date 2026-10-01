#!/bin/sh
# Run this on your laptop: forwards ports from this server to your laptop over one SSH connection,
# so http://localhost:<port> on the laptop reaches localhost:<port> on the server.
#
#   ./remoteConnect.sh 4200 3510            the app (ng serve) and the API docs
#   ./remoteConnect.sh 4200 3500 3510       … and the gateway directly
#   ./remoteConnect.sh 8080:4200            laptop port 8080 → server port 4200 (when 4200 is busy locally)
#
# Ports used by this project on the server:
#   4200 frontend (ng serve; it forwards /api to the gateway itself, so 4200 alone runs the app)
#   3500 gateway   3501 identity   3502 edrms   3503 bpm   3504 intake   3510 API docs (Swagger UI)
#
# Override the connection with environment variables if needed:
#   SSH_KEY (default ~/.ssh/id_rsa_oc)   SSH_PORT (default 2222)   REMOTE (default openclawuser@95.216.13.114)
#   DRY_RUN=1 prints the ssh command instead of running it.

SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_rsa_oc}
SSH_PORT=${SSH_PORT:-2222}
REMOTE=${REMOTE:-openclawuser@95.216.13.114}

usage() {
    echo "Usage: $0 PORT [PORT ...]     (a PORT is 4200, or LAPTOP_PORT:SERVER_PORT such as 8080:4200)"
    echo "Example: $0 4200 3510         the app and the API docs"
}

if [ $# -eq 0 ]; then
    echo "No ports given. Please give the port number(s) to connect to."
    usage
    exit 1
fi

is_port() {
    case $1 in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

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
    case " $URLS " in
        *" http://localhost:$local_port "*) echo "Laptop port $local_port is given twice"; exit 1 ;;
    esac
    FORWARDS="$FORWARDS -L $local_port:localhost:$remote_port"
    URLS="$URLS http://localhost:$local_port"
done

if [ ! -f "$SSH_KEY" ]; then
    echo "SSH key not found: $SSH_KEY (set SSH_KEY to use another one)"
    exit 1
fi

# ExitOnForwardFailure: stop with an error instead of silently skipping a port that is busy on the
# laptop. ServerAlive*: notice a dropped connection within about a minute.
# $FORWARDS is unquoted on purpose: it holds several "-L a:localhost:b" arguments.
set -- ssh -i "$SSH_KEY" -p "$SSH_PORT" -N \
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
