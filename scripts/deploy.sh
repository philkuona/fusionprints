#!/bin/bash
#
# Deploy FusionPrints backend to Hetzner production
#
# Usage: npm run deploy
#   (or directly: ./scripts/deploy.sh)
#
# Prerequisites:
#   - On main branch
#   - All changes committed and pushed
#   - SSH access to fusionprints@<server> via your SSH key
#
# What it does:
#   1. Verifies clean local state (on main, no uncommitted changes)
#   2. Pushes any unpushed commits to GitHub
#   3. SSHes into the server as the fusionprints deploy user
#   4. git pull from GitHub
#   5. npm ci (only if package-lock.json changed)
#   6. Run database migrations (idempotent)
#   7. Restart the systemd service
#   8. Reports success or shows logs on failure

set -euo pipefail

# ===== Config =====
PROD_USER="fusionprints"
PROD_HOST="178.104.67.122"
APP_DIR="/home/fusionprints/app"
SERVICE_NAME="fusionprints"

# ===== Pretty colors =====
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

step() { echo -e "${BOLD}${GREEN}==>${NC} ${BOLD}$*${NC}"; }
warn() { echo -e "${YELLOW}!  $*${NC}"; }
fail() { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

# ===== Pre-flight checks =====
step "Pre-flight checks"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
    fail "Not on main branch (currently on '$BRANCH'). Switch to main before deploying."
fi
echo "   On branch: main ✓"

if ! git diff-index --quiet HEAD --; then
    fail "You have uncommitted changes. Commit or stash them before deploying."
fi
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
    warn "You have untracked files (these won't be deployed):"
    git ls-files --others --exclude-standard | sed 's/^/      /'
fi
echo "   Working tree clean ✓"

# ===== Push if needed =====
step "Pushing to GitHub"
git fetch origin --quiet
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "none")

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "   Already up to date with origin/main ✓"
else
    AHEAD=$(git rev-list --count "@{u}..HEAD")
    echo "   Pushing $AHEAD commit(s) to origin/main..."
    git push
fi

LATEST_COMMIT=$(git log -1 --format="%h %s")
echo "   Latest commit: $LATEST_COMMIT"

# ===== Deploy =====
step "Deploying to ${PROD_HOST}"

ssh -o ConnectTimeout=10 "${PROD_USER}@${PROD_HOST}" bash -se <<EOF
set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'

cd ${APP_DIR}

echo -e "\${GREEN}==>\${NC} Pulling latest code"
PRE_PULL=\$(git rev-parse HEAD)
git pull --quiet
POST_PULL=\$(git rev-parse HEAD)

if [ "\$PRE_PULL" = "\$POST_PULL" ]; then
    echo "   Already up to date — nothing to do"
    exit 0
fi

echo "   Updated: \$(git log --oneline \${PRE_PULL}..\${POST_PULL} | head -10)"

if git diff --name-only \${PRE_PULL} \${POST_PULL} | grep -q '^package-lock.json\$'; then
    echo -e "\${GREEN}==>\${NC} Installing dependencies (package-lock changed)"
    npm ci --silent
else
    echo "   Dependencies unchanged — skipping npm ci"
fi

echo -e "\${GREEN}==>\${NC} Running database migrations"
npm run db:migrate 2>&1 | tail -5

echo -e "\${GREEN}==>\${NC} Restarting service"
sudo /bin/systemctl restart ${SERVICE_NAME}
sleep 2

if sudo /bin/systemctl is-active --quiet ${SERVICE_NAME}; then
    echo "   Service active ✓"
else
    echo "   Service failed to start! Last 20 log lines:"
    sudo /bin/systemctl status ${SERVICE_NAME} --no-pager | tail -20 || true
    exit 1
fi
EOF

echo ""
step "Deploy complete"
echo -e "   ${GREEN}✓${NC} Code pulled"
echo -e "   ${GREEN}✓${NC} Migrations applied"
echo -e "   ${GREEN}✓${NC} Service restarted"
echo ""
echo "   Verify: curl https://api.fusionprints.co.zw/health"
echo "   Logs:   ssh root@${PROD_HOST} journalctl -u ${SERVICE_NAME} -f"
