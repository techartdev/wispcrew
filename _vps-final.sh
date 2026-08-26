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

echo "=== the test the objective actually asks for ==="
echo "    can a program learn this tool from capabilities alone?"
echo ""

# Read the schema, pick a command, run it — using only what the JSON says.
$CLI capabilities --json > /tmp/caps.json

node -e '
const caps = require("/tmp/caps.json");
const { execSync } = require("child_process");

console.log("  schema version : " + caps.schema);
console.log("  commands found : " + caps.commands.length);

// Choose a read-only command with no required arguments, the way a cautious
// caller would: run something harmless first to confirm the contract.
const safe = caps.commands.find(
  (c) => c.args.length === 0 && /list|current|other machines/i.test(c.summary),
);
console.log("  chose          : " + safe.name + " (" + safe.summary + ")");
console.log("  it returns     : " + safe.returns);

const out = execSync("node apps/daemon/dist/cli.js " + safe.name + " --json", {
  cwd: "/opt/wispcrew",
  encoding: "utf8",
});

const parsed = JSON.parse(out);
const shape = Array.isArray(parsed) ? "array of " + parsed.length : typeof parsed;
console.log("  actually got   : " + shape);
console.log("");
console.log("  matches the declared return: " +
  (safe.returns.startsWith("array") === Array.isArray(parsed)));
'

echo ""
echo "=== rooms tail, the headless visibility command ==="
$CLI rooms tail Linux --lines 4
