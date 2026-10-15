# OpenBao in the container setup (deploy/docker-compose.yml, profile bao). Single node, its data in
# the bao-data volume. Reachable only from the other containers (no port on the host), so it
# listens without TLS on the private container network. Initialising and unsealing: README.md.
storage "raft" {
  path    = "/openbao/file"
  node_id = "lrfe-bao"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://openbao:8200"
cluster_addr = "http://openbao:8201"
ui           = false
