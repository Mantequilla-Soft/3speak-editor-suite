#!/usr/bin/env bash
# One-time setup for automatic editor deploys (merged PR on main -> both prod editor boxes).
#
#   As root, from the repo's deploy/ folder (or a copy of it on the other server for step 2).
#   1. On this box (A: frontend + gateway + backend 3speak-editor-api.okinoko.io):
#        sudo B_HOST=15.204.229.29 B_SSH_PORT=22 bash setup.sh a
#      prints a public key line.
#   2. On the other server (B: backend editor.3speak.tv):
#        sudo EDITOR_REPO=/path/to/editor/checkout EDITOR_REMOTE=origin \
#             EDITOR_SERVICES=backend EDITOR_BACKEND_URL=http://127.0.0.1:<backend port> \
#             bash setup.sh b '<the public key line from step 1>'
#   3. Merge the PR that adds .github/workflows/deploy.yml, then Actions > Deploy > check.
#
# Each box gets:
#   1. system user `deploy-editor`: password locked, key only, no forwarding/tty/shell,
#      its key forced to /usr/local/sbin/editor-deploy-entry ("deploy <sha>" / "check <sha>")
#   2. /usr/local/sbin/editor-deploy (root-owned) + a sudoers rule for exactly that script
#   3. /etc/editor-deploy.conf (checkout, remote, services, local URLs)
#   4. an sshd drop-in with the per-user restrictions (`sshd -t` before reload)
# Box A also creates the key pair and the GitHub environment `editor-production` on
# Mantequilla-Soft/3speak-editor-suite (usable only from `main`): secrets DEPLOY_SSH_KEY +
# DEPLOY_KNOWN_HOSTS, variables A_HOST/A_PORT, B_HOST/B_PORT, DEPLOY_USER. The local
# private key is deleted afterwards.
#
# Safe to re-run. Re-running step 1 rotates the key: run step 2 again with the new line.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
USER_NAME=deploy-editor
REPO_GH=Mantequilla-Soft/3speak-editor-suite
ENV_NAME=editor-production
role="${1:-}"

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
case "$role" in a|b) ;; *) echo "usage: setup.sh a | setup.sh b '<public key line>'"; exit 1 ;; esac
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || { echo "docker compose missing"; exit 1; }

if [ "$role" = a ]; then
  REPO=/home/dockeruser/3speak-editor
  REMOTE=suite
  SERVICES="gateway backend frontend"
  BACKEND_URL=http://127.0.0.1:3102
  FRONTEND_URL=http://127.0.0.1:8089
  GATEWAY_URL=http://127.0.0.1:3200
  HOST_IP=65.109.133.80; SSH_PORT=23051
  : "${B_HOST:?set B_HOST (the other server, editor.3speak.tv)}"
  : "${B_SSH_PORT:?set B_SSH_PORT (its sshd port)}"
  command -v gh >/dev/null || { echo "gh CLI missing"; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh is not logged in for root"; exit 1; }
else
  : "${EDITOR_REPO:?set EDITOR_REPO (the editor checkout docker compose runs from)}"
  : "${EDITOR_BACKEND_URL:?set EDITOR_BACKEND_URL (e.g. http://127.0.0.1:3102)}"
  REPO=$EDITOR_REPO
  REMOTE=${EDITOR_REMOTE:-origin}
  SERVICES=${EDITOR_SERVICES:-backend}
  BACKEND_URL=$EDITOR_BACKEND_URL
  FRONTEND_URL=${EDITOR_FRONTEND_URL:-}
  GATEWAY_URL=${EDITOR_GATEWAY_URL:-}
  PUBLINE="${2:-}"
  [[ "$PUBLINE" =~ ^restrict,command=\"/usr/local/sbin/editor-deploy-entry\"\ ssh-ed25519\ [A-Za-z0-9+/=]+\ [^[:space:]]+$ ]] \
    || { echo "pass the public key line printed by step 1, in single quotes"; exit 1; }
fi
[ -d "$REPO/.git" ] || { echo "$REPO is not a git checkout"; exit 1; }
git -C "$REPO" remote get-url "$REMOTE" >/dev/null || { echo "$REPO has no git remote '$REMOTE'"; exit 1; }
git -C "$REPO" remote get-url "$REMOTE" | grep -q '3speak-editor-suite' \
  || { echo "remote '$REMOTE' is not Mantequilla-Soft/3speak-editor-suite"; exit 1; }
for s in $SERVICES; do
  (cd "$REPO" && docker compose ps -q "$s" | grep -q .) || { echo "compose service '$s' is not running in $REPO"; exit 1; }
done

echo "==> 1. user"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /bin/bash \
    --comment "GitHub Action deploys of the editor (forced command only)" "$USER_NAME"
fi
passwd -l "$USER_NAME" >/dev/null

echo "==> 2. scripts + sudoers"
install -o root -g root -m 0755 "$HERE/editor-deploy" /usr/local/sbin/editor-deploy
install -o root -g root -m 0755 "$HERE/editor-deploy-entry" /usr/local/sbin/editor-deploy-entry
tmp_sudo=$(mktemp)
cat > "$tmp_sudo" <<EOF
# The editor deploy user may run the deploy script with one of its two verbs, nothing else.
# The script itself validates the commit argument (40 lowercase hex characters).
$USER_NAME ALL=(root) NOPASSWD: /usr/local/sbin/editor-deploy deploy *, /usr/local/sbin/editor-deploy check *
Defaults:$USER_NAME !requiretty
EOF
visudo -cf "$tmp_sudo" >/dev/null
install -o root -g root -m 0440 "$tmp_sudo" /etc/sudoers.d/deploy-editor
rm -f "$tmp_sudo"
visudo -c >/dev/null

echo "==> 3. /etc/editor-deploy.conf"
cat > /etc/editor-deploy.conf <<EOF
# Read by /usr/local/sbin/editor-deploy (parsed as KEY=VALUE, never sourced).
NAME=$role
REPO=$REPO
REMOTE=$REMOTE
SERVICES="$SERVICES"
BACKEND_URL=$BACKEND_URL
FRONTEND_URL=$FRONTEND_URL
GATEWAY_URL=$GATEWAY_URL
# This box's own settings in a tracked file: kept on every deploy; an upstream change to it
# stops the deploy for a human to merge.
ALLOWED_LOCAL="docker-compose.yml"
# The production frontend must never point at the dev editor or localhost.
FORBID_IN_BUNDLE="deveditor localhost:"
EOF
chmod 0644 /etc/editor-deploy.conf

echo "==> 4. sshd restrictions"
cat > /etc/ssh/sshd_config.d/62-deploy-editor.conf <<EOF
# Editor deploy user: key only, one forced command, nothing else.
Match User $USER_NAME
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitUserRC no
    ForceCommand /usr/local/sbin/editor-deploy-entry
# Close the Match block, so nothing included after this file is scoped to the deploy user.
Match all
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
if sshd -T 2>/dev/null | grep -qiE '^(allowusers|allowgroups) '; then
  sshd -T | grep -iE '^(allowusers|allowgroups) ' | grep -qw "$USER_NAME" \
    || { echo "!! sshd has AllowUsers/AllowGroups: add $USER_NAME there, or the Action cannot log in"; exit 1; }
fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "/home/$USER_NAME/.ssh"

if [ "$role" = b ]; then
  printf '%s\n' "$PUBLINE" > "/home/$USER_NAME/.ssh/authorized_keys"
  chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
  chmod 0600 "/home/$USER_NAME/.ssh/authorized_keys"
  echo "==> 5. self-test"
  if SSH_ORIGINAL_COMMAND=id /usr/local/sbin/editor-deploy-entry 2>/dev/null; then echo "!! entry ran an arbitrary command"; exit 1; fi
  echo "   arbitrary command refused: ok"
  tip=$(git -C "$REPO" ls-remote "$REMOTE" refs/heads/main | cut -f1)
  runuser -u "$USER_NAME" -- sudo -n /usr/local/sbin/editor-deploy check "$tip"
  echo
  echo "Done. This box's host key (compare with what step 1 pinned):"
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
  exit 0
fi

echo "==> 5. key pair"
keydir=$(mktemp -d)
trap 'rm -rf "$keydir"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "github-actions@$REPO_GH" -f "$keydir/id"
publine="restrict,command=\"/usr/local/sbin/editor-deploy-entry\" $(cut -d' ' -f1,2 "$keydir/id.pub") github-actions@$REPO_GH"
printf '%s\n' "$publine" > "/home/$USER_NAME/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
chmod 0600 "/home/$USER_NAME/.ssh/authorized_keys"
printf '%s\n' "$publine" > "$HERE/deploy-editor.pub.line"

echo "==> 6. known hosts (A from its own key, B via ssh-keyscan)"
known_a="[$HOST_IP]:$SSH_PORT $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
b_key=$(ssh-keyscan -T 10 -t ed25519 -p "$B_SSH_PORT" "$B_HOST" 2>/dev/null | grep -v '^#' | head -1 | cut -d' ' -f2,3)
[ -n "$b_key" ] || { echo "ssh-keyscan of $B_HOST:$B_SSH_PORT returned nothing"; exit 1; }
if [ "$B_SSH_PORT" = 22 ]; then known_b="$B_HOST $b_key"; else known_b="[$B_HOST]:$B_SSH_PORT $b_key"; fi
echo "   pinned B host key: $(printf '%s\n' "$known_b" | ssh-keygen -lf - | cut -d' ' -f2)  (step 2 prints B's own; they must match)"

echo "==> 7. GitHub environment + secrets"
gh api -X PUT "repos/$REPO_GH/environments/$ENV_NAME" --silent \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
if ! gh api "repos/$REPO_GH/environments/$ENV_NAME/deployment-branch-policies" -q '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/$REPO_GH/environments/$ENV_NAME/deployment-branch-policies" --silent -f name=main -f type=branch
fi
gh secret set DEPLOY_SSH_KEY --env "$ENV_NAME" -R "$REPO_GH" < "$keydir/id"
printf '%s\n%s\n' "$known_a" "$known_b" | gh secret set DEPLOY_KNOWN_HOSTS --env "$ENV_NAME" -R "$REPO_GH"
gh variable set A_HOST --env "$ENV_NAME" -R "$REPO_GH" --body "$HOST_IP"
gh variable set A_PORT --env "$ENV_NAME" -R "$REPO_GH" --body "$SSH_PORT"
gh variable set B_HOST --env "$ENV_NAME" -R "$REPO_GH" --body "$B_HOST"
gh variable set B_PORT --env "$ENV_NAME" -R "$REPO_GH" --body "$B_SSH_PORT"
gh variable set DEPLOY_USER --env "$ENV_NAME" -R "$REPO_GH" --body "$USER_NAME"

echo "==> 8. self-test (A, over ssh with the new key)"
kh=$(mktemp); printf '[127.0.0.1]:%s %s\n' "$SSH_PORT" "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > "$kh"
sshq() { ssh -i "$keydir/id" -p "$SSH_PORT" -o IdentitiesOnly=yes -o UserKnownHostsFile="$kh" -o StrictHostKeyChecking=yes -o BatchMode=yes "$USER_NAME@127.0.0.1" "$@"; }
if sshq id 2>/dev/null; then echo "!! the key could run an arbitrary command"; exit 1; fi
echo "   arbitrary command refused: ok"
tip=$(git -C "$REPO" ls-remote "$REMOTE" refs/heads/main | cut -f1)
sshq "check $tip"
rm -f "$kh"

echo
echo "Done. The private key now lives only in the GitHub environment '$ENV_NAME'."
echo "Next, on the other server (as root, with this folder copied there):"
echo "  sudo EDITOR_REPO=<checkout> EDITOR_BACKEND_URL=http://127.0.0.1:<port> bash setup.sh b '$publine'"
echo "(the line is also saved in $HERE/deploy-editor.pub.line)"
