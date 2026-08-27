/**
 * sweep.cjs — exercise every feature against a running app, and report.
 *
 * Written as one script rather than a dozen probes because the point is
 * COVERAGE: a feature nobody thought to try is exactly the one a user finds
 * broken. Each check reports what actually happened, so a failure names the
 * behaviour rather than an assertion number.
 *
 * Run inside Electron with the real profile, so the daemon, the paired VPS
 * and the real provider are all in play. Nothing here is a unit test.
 */
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const orig = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn);
  return orig(channel, fn);
};

const results = [];
const record = (area, outcome, detail) => results.push({ area, outcome, detail });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await import('./dist/main.mjs');
  await app.whenReady();
  await wait(14000);

  const call = (c, ...a) => handlers.get(c)({}, ...a);

  /** Wait for a condition, rather than hoping a fixed delay covered it. */
  const until = async (fn, seconds = 40) => {
    for (let i = 0; i < seconds; i++) {
      const value = await fn();
      if (value) return value;
      await wait(1000);
    }
    return null;
  };

  let scratch = null;

  try {
    /* ---- a local agent, made for the sweep ---------------------- */
    scratch = await call('wc:createAgent', {
      name: 'SweepProbe',
      description: 'You answer in one short sentence. Use tools when asked.',
      approvalPolicy: 'auto',
    });
    record('create an agent', scratch?.id ? 'pass' : 'FAIL', scratch?.name);

    const room = (await call('wc:listConversations')).find((r) => r.id === scratch.id);
    record('it arrives with a room', room ? 'pass' : 'FAIL',
      room ? `${(room.participants ?? []).length} participants` : 'no room');

    /* ---- streaming chat ----------------------------------------- */
    await call('wc:sendToRoom', scratch.id, 'Say exactly: hello there');
    const reply = await until(async () => {
      const t = await call('wc:getTranscript', scratch.id);
      return t.find((e) => e.kind === 'message' && e.role === 'assistant');
    });
    record('streaming chat', reply ? 'pass' : 'FAIL',
      String(reply?.content ?? '').slice(0, 50));

    /* ---- multi-turn memory -------------------------------------- */
    await call('wc:sendToRoom', scratch.id, 'Remember the number 41.');
    await until(async () => {
      const t = await call('wc:getTranscript', scratch.id);
      return t.filter((e) => e.kind === 'message' && e.role === 'assistant').length >= 2;
    });
    await call('wc:sendToRoom', scratch.id, 'What number did I ask you to remember?');
    const recalled = await until(async () => {
      const t = await call('wc:getTranscript', scratch.id);
      const last = t.filter((e) => e.kind === 'message' && e.role === 'assistant').at(-1);
      return String(last?.content ?? '').includes('41') ? last : null;
    });
    record('multi-turn memory', recalled ? 'pass' : 'FAIL',
      String(recalled?.content ?? '(did not recall 41)').slice(0, 50));

    /* ---- tool calls, auto policy -------------------------------- */
    await call('wc:sendToRoom', scratch.id, 'List the files in your workspace.');
    const tooled = await until(async () => {
      const t = await call('wc:getTranscript', scratch.id);
      return t.find((e) => e.kind === 'tool-call');
    }, 50);
    record('tool call (auto)', tooled ? 'pass' : 'FAIL',
      tooled ? `${tooled.toolName ?? '?'} ${tooled.status ?? ''}` : 'no tool call');

    /* ---- interrupt ---------------------------------------------- */
    await call('wc:sendToRoom', scratch.id, 'Write five long paragraphs about the sea.');
    await wait(5000);
    await call('wc:interrupt', scratch.id);
    await wait(4000);
    const afterStop = await call('wc:getTranscript', scratch.id);
    const stopped = afterStop.some(
      (e) => e.kind === 'notice' && String(e.text ?? '').includes('interrupted'),
    );
    record('interrupt', stopped ? 'pass' : 'FAIL',
      stopped ? 'run interrupted, transcript kept' : 'no interruption notice');

    /* ---- rewind and branch -------------------------------------- */
    const entries = await call('wc:getTranscript', scratch.id);
    const midpoint = entries.filter((e) => e.kind === 'message').at(1);
    if (midpoint) {
      const kept = await call('wc:rewindConversation', scratch.id, midpoint.id, 'through');
      record('rewind', Array.isArray(kept) && kept.length < entries.length ? 'pass' : 'FAIL',
        `${entries.length} -> ${kept?.length}`);

      const versions = await call('wc:listHistory', scratch.id);
      record('history keeps the removed part', versions?.length > 0 ? 'pass' : 'FAIL',
        `${versions?.length ?? 0} versions`);

      if (versions?.length) {
        await call('wc:restoreHistory', scratch.id, versions[0].id);
        const restored = await call('wc:getTranscript', scratch.id);
        record('restore', restored.length >= entries.length ? 'pass' : 'FAIL',
          `back to ${restored.length}`);
      }

      const branch = await call('wc:branchConversation', scratch.id, midpoint.id);
      record('branch', branch?.id ? 'pass' : 'FAIL', branch?.name);
      if (branch?.id) await call('wc:deleteAgent', branch.id);
    } else {
      record('rewind / branch', 'SKIP', 'no midpoint entry to rewind to');
    }

    /* ---- skills -------------------------------------------------- */
    const skills = await call('wc:listSkills');
    record('skills list', Array.isArray(skills) ? 'pass' : 'FAIL', `${skills?.length ?? 0} skills`);

    /* ---- routines ------------------------------------------------ */
    const routine = await call('wc:createRoutine', {
      agentId: scratch.id,
      name: 'SweepRoutine',
      cron: '0 9 * * *',
      prompt: 'Say hello.',
      enabled: true,
    });
    record('create a routine', routine?.id ? 'pass' : 'FAIL', routine?.name);

    if (routine?.id) {
      await call('wc:runRoutineNow', routine.id);
      const ran = await until(async () => {
        const t = await call('wc:getTranscript', scratch.id);
        return t.some((e) => e.kind === 'notice' && String(e.text ?? '').includes('SweepRoutine'));
      }, 45);
      record('run a routine now', ran ? 'pass' : 'FAIL', ran ? 'it fired' : 'no notice');
      await call('wc:deleteRoutine', routine.id);
    }

    /* ---- MCP ----------------------------------------------------- */
    const mcp = await call('wc:listMcpServers');
    record('MCP servers list', Array.isArray(mcp) ? 'pass' : 'FAIL', `${mcp?.length ?? 0} servers`);

    /* ---- attachments --------------------------------------------- */
    const tmp = path.join(os.tmpdir(), 'wispcrew-sweep.txt');
    fs.writeFileSync(tmp, 'The secret word is albatross.', 'utf8');
    await call('wc:sendToRoom', scratch.id, 'What is the secret word in this file?', [tmp]);
    const sawFile = await until(async () => {
      const t = await call('wc:getTranscript', scratch.id);
      const last = t.filter((e) => e.kind === 'message' && e.role === 'assistant').at(-1);
      return String(last?.content ?? '').toLowerCase().includes('albatross') ? last : null;
    }, 50);
    record('attachments', sawFile ? 'pass' : 'FAIL',
      String(sawFile?.content ?? '(did not read the file)').slice(0, 50));

    /* ---- a room with two agents ---------------------------------- */
    const second = await call('wc:createAgent', {
      name: 'SweepSecond',
      description: 'You answer in one short sentence.',
      approvalPolicy: 'auto',
    });
    await call('wc:addRoomAgent', scratch.id, second.id);
    const shared = (await call('wc:listConversations')).find((r) => r.id === scratch.id);
    const handles = (shared?.participants ?? [])
      .filter((p) => p.kind === 'agent')
      .map((p) => p.handle);
    record('a room with two agents', handles.length === 2 ? 'pass' : 'FAIL', handles.join(' '));

    await call('wc:removeRoomParticipant', scratch.id, second.id);
    await call('wc:deleteAgent', second.id);

    /* ---- the remote agent ---------------------------------------- */
    const agents = await call('wc:listAgents');
    const remote = agents.find((a) => a.nodeId);
    if (remote) {
      const before = (await call('wc:getTranscript', remote.id)).length;
      await call('wc:sendToRoom', remote.id, 'Say exactly: remote alive');
      const answered = await until(async () => {
        const t = await call('wc:getTranscript', remote.id);
        return t.slice(before).find((e) => e.kind === 'message' && e.role === 'assistant');
      }, 45);
      record('remote agent chat', answered ? 'pass' : 'FAIL',
        String(answered?.content ?? '(no reply)').slice(0, 50));
    } else {
      record('remote agent chat', 'SKIP', 'no paired agent in this profile');
    }

    /* ---- machines ------------------------------------------------ */
    const nodes = await call('wc:listNodes');
    record('paired machines', Array.isArray(nodes) ? 'pass' : 'FAIL',
      nodes.map((n) => `${n.name}=${n.connected ? 'connected' : 'offline'}`).join(', ') || 'none');

    /* ---- settings and providers ---------------------------------- */
    const settings = await call('wc:getSettings');
    record('settings readable', settings ? 'pass' : 'FAIL',
      `${settings?.presetId} hasKey=${Boolean(settings?.hasApiKey)}`);
    record('no key leaks to the renderer',
      settings && !('apiKey' in settings) ? 'pass' : 'FAIL', '');

    const models = await call('wc:listProviderModels', settings?.presetId ?? 'nvidia');
    record('provider catalogue', models?.length > 6 ? 'pass' : 'FAIL',
      `${models?.length ?? 0} models, ${models?.filter((m) => m.tested).length ?? 0} tested`);
  } catch (err) {
    record('sweep', 'THREW', err.message);
  } finally {
    if (scratch?.id) {
      try {
        await call('wc:deleteAgent', scratch.id);
      } catch {
        /* leaving one probe agent behind is not worth masking the report */
      }
    }
  }

  console.log('SWEEP_JSON:' + JSON.stringify(results));
  app.exit(0);
})();
