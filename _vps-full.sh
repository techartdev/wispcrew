cd /opt/wispcrew
git fetch -q origin main
git reset --hard -q origin/main
npm run build:packages >/dev/null 2>&1
npm run build --workspace @wispcrew/daemon >/dev/null 2>&1

pkill -f 'apps/daemon/dist/cli.js' 2>/dev/null || true
sleep 2
nohup node apps/daemon/dist/cli.js serve --listen --network > /var/log/wispcrew-node.log 2>&1 &
sleep 7

CLI="node apps/daemon/dist/cli.js"

echo "=== how many commands does this machine offer? ==="
$CLI capabilities --json | node -e '
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const c = JSON.parse(raw);
  console.log("  commands: " + c.commands.length);
  console.log("  provider: " + c.provider.preset + (c.provider.configured ? "" : " (no key)"));
});
'

echo ""
echo "=== the ones that matter on a server, with no GUI anywhere ==="
$CLI providers | head -3
echo ""
$CLI routines
echo ""
$CLI grants
echo ""
$CLI test provider
