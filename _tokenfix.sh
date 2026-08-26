cd /opt/wispcrew
git fetch -q origin main
git reset --hard -q origin/main
npm run build --workspace @wispcrew/daemon >/dev/null 2>&1
echo "at $(git rev-parse --short HEAD)"

pkill -f 'apps/daemon/dist/cli.js' 2>/dev/null || true
sleep 2

# First start: creates and stores the token.
nohup node apps/daemon/dist/cli.js serve --listen --network > /var/log/wispcrew-node.log 2>&1 &
sleep 7

TOKEN_A=$(node -e '
const { createNodeCrypto, getSecret, setHost } = require("/opt/wispcrew/packages/runtime/dist/index.js");
const dir = "/root/.config/WispCrew";
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: "p", crypto: createNodeCrypto(dir) });
process.stdout.write((getSecret(dir, "WISPCREW_NODE_NETWORK_TOKEN") || "none").slice(0, 12));
')
echo "after first start : $TOKEN_A"

# Restart, the operation that used to detach every client.
pkill -f 'apps/daemon/dist/cli.js' 2>/dev/null || true
sleep 3
nohup node apps/daemon/dist/cli.js serve --listen --network > /var/log/wispcrew-node.log 2>&1 &
sleep 7

TOKEN_B=$(node -e '
const { createNodeCrypto, getSecret, setHost } = require("/opt/wispcrew/packages/runtime/dist/index.js");
const dir = "/root/.config/WispCrew";
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: "p", crypto: createNodeCrypto(dir) });
process.stdout.write((getSecret(dir, "WISPCREW_NODE_NETWORK_TOKEN") || "none").slice(0, 12));
')
echo "after restart     : $TOKEN_B"

if [ "$TOKEN_A" = "$TOKEN_B" ]; then
  echo "SURVIVED: yes"
else
  echo "SURVIVED: NO - still regenerating"
fi
