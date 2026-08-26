KEY=$(node -e '
const { createNodeCrypto, getSecret, providerSecretKey, setHost } = require("/opt/wispcrew/packages/runtime/dist/index.js");
const dir = "/root/.config/WispCrew";
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: "p", crypto: createNodeCrypto(dir) });
process.stdout.write(getSecret(dir, providerSecretKey("nvidia")) || "");
')

echo "=== the same model, a minimal request ==="
curl -s -o /tmp/r.json -w "  status %{http_code}\n" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mistralai/mistral-nemotron","messages":[{"role":"user","content":"say ready"}],"max_tokens":10}' \
  https://integrate.api.nvidia.com/v1/chat/completions

head -c 300 /tmp/r.json
echo ""

echo ""
echo "=== a different model, same key ==="
curl -s -o /tmp/r2.json -w "  status %{http_code}\n" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"say ready"}],"max_tokens":10}' \
  https://integrate.api.nvidia.com/v1/chat/completions

head -c 300 /tmp/r2.json
echo ""
