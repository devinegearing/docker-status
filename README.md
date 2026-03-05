# docker-status

Lightweight Docker container status dashboard. Zero dependencies — just Node.js.

Queries the Docker Engine API via the Unix socket and serves a self-contained HTML dashboard that auto-refreshes every 5 seconds.

## Quick Start

```bash
node server.js
# → http://localhost:8080
```

Requires access to `/var/run/docker.sock`.

## Docker Deployment

```bash
docker compose up -d
```

The compose file mounts the Docker socket read-only so the dashboard can see sibling containers.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP server port |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Path to Docker socket |
