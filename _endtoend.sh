cd /opt/wispcrew
CLI="node apps/daemon/dist/cli.js"

# Restart so the daemon picks up the new model.
pkill -f 'apps/daemon/dist/cli.js' 2>/dev/null || true
sleep 2
nohup node apps/daemon/dist/cli.js serve --listen --network > /var/log/wispcrew-node.log 2>&1 &
sleep 7

echo "=== ask, with a real model, on a real headless machine ==="
$CLI ask Linux "Run the command 'uname -srm' and quote exactly what it printed." --timeout 150

echo ""
echo "=== the same thing as JSON, for a program ==="
$CLI ask Linux "Reply with just the word: ready" --timeout 120 --json

echo ""
echo "=== tasks, showing what just ran ==="
$CLI tasks
