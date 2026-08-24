/**
 * GhostBot CLI example — headless agent with any LLM.
 *
 * Usage:
 *   GHOSTBOT_PROVIDER=deepseek GHOSTBOT_API_KEY=sk-... npm run agent -- "list files and summarize"
 *   GHOSTBOT_PROVIDER=ollama npm run agent -- "what time is it?"   (local, no key)
 *
 * Interactive REPL when no prompt argument is given.
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { configFromPreset, createProvider } from '@ghostbot/llm';
import { Agent } from '@ghostbot/core';
import type { AgentEvent, ApprovalRequest } from '@ghostbot/shared';

function env(key: string): string | undefined {
  return process.env[key];
}

function buildAgent() {
  const presetId = env('GHOSTBOT_PROVIDER') ?? 'deepseek';
  const config = configFromPreset(presetId, {
    apiKey: env('GHOSTBOT_API_KEY'),
    model: env('GHOSTBOT_MODEL'),
    baseUrl: env('GHOSTBOT_BASE_URL'),
  });
  const provider = createProvider(config);
  const check = provider.validate();
  if (!check.ok) {
    console.error(`Provider config invalid: ${check.error}`);
    process.exit(1);
  }

  const rl = createInterface({ input, output });
  const agent = new Agent({
    provider,
    workspaceRoot: process.cwd(),
    onEvent: (e: AgentEvent) => {
      if (e.type === 'tool_call_start') console.log(`\n\x1b[36m[tool] ${e.call.name}\x1b[0m ${JSON.stringify(e.call.args)}`);
      if (e.type === 'tool_call_result' && !e.result.ok) console.log(`\x1b[33m[tool error] ${e.result.content.slice(0, 300)}\x1b[0m`);
      if (e.type === 'error') console.error(`\x1b[31m[error] ${e.message}\x1b[0m`);
    },
    onApprovalRequired: async (req: ApprovalRequest) => {
      const answer = await rl.question(`\n\x1b[33m[approval] ${req.summary}\nAllow? (y/N) \x1b[0m`);
      return answer.trim().toLowerCase().startsWith('y');
    },
  });
  return { agent, rl };
}

async function main() {
  const prompt = process.argv.slice(2).join(' ');
  const { agent, rl } = buildAgent();

  const runTurn = async (message: string) => {
    process.stdout.write('\n\x1b[32m[agent]\x1b[0m ');
    const result = await agent.run(message);
    process.stdout.write(`\n\n\x1b[90m${'-'.repeat(60)}\x1b[0m\n`);
    return result;
  };

  if (prompt) {
    const r = await runTurn(prompt);
    console.log(`\n\x1b[1mFinal answer:\x1b[0m\n${r.content}`);
    rl.close();
    return;
  }

  console.log('GhostBot CLI — type a message, Ctrl+C to exit.');
  while (true) {
    const line = await rl.question('\x1b[32m> \x1b[0m');
    if (!line.trim()) continue;
    try {
      await runTurn(line);
    } catch (err) {
      console.error(`\n\x1b[31mTurn failed: ${(err as Error).message}\x1b[0m`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
