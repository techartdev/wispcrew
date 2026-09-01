const { app, ipcMain } = require('electron');
const orig = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, fn) => { handlers.set(channel, fn); return orig(channel, fn); };
(async () => {
  await import('./dist/main.mjs');
  await app.whenReady();
  await new Promise(r => setTimeout(r, 4000));
  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  const agents = await call('wc:listAgents');
  const nudge = agents.find(a => a.name === 'Nudge');
  if (!nudge) throw new Error('Nudge was not found');
  await call('wc:sendToRoom', nudge.id, 'Briefly confirm how you would make a one-time reminder and a recurring weekday 09:00 reminder. Give the cron expression and say whether the recurring reminder needs user approval.');
  await new Promise(r => setTimeout(r, 60000));
  const transcript = await call('wc:getTranscript', nudge.id);
  console.log(JSON.stringify(transcript.slice(-6), null, 2));
  app.exit(0);
})().catch(err => { console.error(err.stack || err); app.exit(1); });
