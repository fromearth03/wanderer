# Deployment

Wanderer runs on one server with Docker Compose behind Caddy (HTTPS on 443).

## CI/CD flow

1. Push to `main`.
2. GitHub Actions (`.github/workflows/ci.yml`) runs the Go tests, the Python import check,
   the web build with the focus-mode check, and a Docker image build.
3. On the server, `wanderer-deploy.timer` runs `deploy/poll-deploy.sh` every 2 minutes.
   It fetches `main`, and when a new commit has passed CI it checks it out, rebuilds the
   containers and checks `/api/health`. If the new version is unhealthy it rolls back to
   the previous commit and remembers the bad one.

The server only pulls a public repository, so no deploy keys or server credentials are
stored on GitHub.

## Install on the server (once)

```sh
sudo cp deploy/wanderer-deploy.service deploy/wanderer-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wanderer-deploy.timer
```

Logs: `journalctl -u wanderer-deploy.service -f`. Deploy now: `sudo systemctl start wanderer-deploy.service`.
