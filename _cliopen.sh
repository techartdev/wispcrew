cd /opt/wispcrew
git fetch -q origin main
git reset --hard -q origin/main
npm run build --workspace @wispcrew/daemon >/dev/null 2>&1

pkill -f 'apps/daemon/dist/cli.js' 2>/dev/null || true
sleep 2
nohup node apps/daemon/dist/cli.js serve --listen --network --pair > /var/log/wispcrew-node.log 2>&1 &
sleep 7
grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}' /var/log/wispcrew-node.log | head -1
grep -oE '([0-9A-F]{2}:){31}[0-9A-F]{2}' /var/log/wispcrew-node.log | head -1
