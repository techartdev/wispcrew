cd /opt/wispcrew
git fetch -q origin main
git reset --hard -q origin/main
npm run build:packages >/dev/null 2>&1
npm run build --workspace @wispcrew/daemon >/dev/null 2>&1
pkill -f 'apps/daemon/dist/cli.js' 2>/dev/null || true
sleep 2
nohup node apps/daemon/dist/cli.js serve --listen --network > /var/log/wispcrew-node.log 2>&1 &
sleep 8
echo 'node restarted'
node apps/daemon/dist/cli.js agents | head -4
