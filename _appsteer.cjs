/**
 * Drive the real app's IPC handlers the way the UI does:
 * send a message, check it appears, send another mid-run, and switch agents.
 */
const { app, ipcMain } = require('electron');
const fs = require('fs');

const orig = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn);
  return orig(channel, fn);
};

(async () => {
  const out = [];
  try {
    await import('./dist/main.mjs');
    await app.whenReady();
    await new Promise((r) => setTimeout(r, 5000));

    const call = (c, ...a) => handlers.get(c)({}, ...a);
    const agents = await call('gb:listAgents');
    out.push('agents: ' + agents.map((a) => a.name).join(' | '));

    const first = agents[0];
    const second = agents[1] ?? agents[0];

    // 1. Does a typed message appear?
    const before = (await call('gb:getTranscript', first.id)).length;
    await call('gb:sendPrompt', first.id, 'STEER_ONE please count to 20 slowly');
    await new Promise((r) => setTimeout(r, 1200));
    const afterOne = await call('gb:getTranscript', first.id);
    const mine = afterOne.find(
      (e) => e.role === 'user' && String(e.content).includes('STEER_ONE'),
    );
    out.push('1. typed message visible: ' + Boolean(mine));

    // 2. Can a second message be sent while it works?
    const t0 = Date.now();
    await call('gb:sendPrompt', first.id, 'STEER_TWO and mention blue');
    const took = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 1200));
    const afterTwo = await call('gb:getTranscript', first.id);
    const second2 = afterTwo.find(
      (e) => e.role === 'user' && String(e.content).includes('STEER_TWO'),
    );
    out.push(`2. mid-run send returned in ${took}ms, recorded: ` + Boolean(second2));

    // 3. Do the two agents keep separate transcripts?
    if (second.id !== first.id) {
      await call('gb:sendPrompt', second.id, 'STEER_OTHER_AGENT');
      await new Promise((r) => setTimeout(r, 1500));
      const a = await call('gb:getTranscript', first.id);
      const b = await call('gb:getTranscript', second.id);
      const leaked = a.some((e) => String(e.content).includes('STEER_OTHER_AGENT'));
      const landed = b.some((e) => String(e.content).includes('STEER_OTHER_AGENT'));
      out.push(`3. lands on the right agent: ${landed}, leaked to the other: ${leaked}`);
    } else {
      out.push('3. skipped (only one agent)');
    }

    out.push(`   entries: ${before} -> ${afterTwo.length}`);
  } catch (err) {
    out.push('ERROR: ' + err.message);
  }
  fs.writeFileSync('D:/Mine/OpenAgent/steer.txt', out.join('\n'));
  app.exit(0);
})();
