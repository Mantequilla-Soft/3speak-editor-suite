# Automatic production deploys

A PR merged into `main` deploys itself once the `tests` workflow has passed for it
(`.github/workflows/deploy.yml`):

1. **B**, `editor.3speak.tv`: the second render backend (the canary)
2. **A**, `3speak-editor.okinoko.io`: gateway, backend (home of uploads and drafts) and
   frontend, only after B succeeded

Each box runs `/usr/local/sbin/editor-deploy` through an SSH user (`deploy-editor`) that can
do nothing else. The script:

- deploys exactly the tested commit of `main`, never an older one or a newer untested tip
- rebuilds only what changed (`backend/` → backend, `gateway/` → gateway, the rest →
  frontend; docs, tests, `deploy/` and `.github/` rebuild nothing) while the old containers
  keep serving
- keeps each box's own `docker-compose.yml`; a PR that changes it stops the deploy so a
  human merges the settings by hand
- swaps a backend only when it renders nothing (`activeJobs` 0, waits up to 30 minutes)
- smoke tests every swapped service (health, anonymous upload/render refused, the frontend
  bundle has no dev editor URLs) and rolls back to the previous images on any failure

Manual run: Actions > Deploy > Run workflow, mode `check` (verify both boxes, change
nothing) or `deploy`. Logs on each box: `/var/log/editor-deploy.log`.

## One-time setup (as root)

1. On A: `B_HOST=15.204.229.29 B_SSH_PORT=22 bash deploy/setup.sh a` prints a public key line
   and creates the GitHub environment `editor-production` (secrets + variables).
2. On B, with this folder there:
   `EDITOR_REPO=<checkout> EDITOR_REMOTE=<remote of this repo> EDITOR_BACKEND_URL=http://127.0.0.1:<port> bash setup.sh b '<the line>'`
3. Merge the PR that added this, then Actions > Deploy > `check`.

Tests: `bash deploy/tests/run.sh`.
