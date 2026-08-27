const { app, ipcMain } = require('electron');
const orig = ipcMain.handle.bind(ipcMain);
const h = new Map();
ipcMain.handle = (c, f) => { h.set(c, f); return orig(c, f); };
(async () => {
  await import('./dist/main.mjs');
  await app.whenReady();
  await new Promise(r => setTimeout(r, 13000));
  const call = (c, ...a) => h.get(c)({}, ...a);
  const a = await call('wc:createAgent', { name: 'DiagProbe', approvalPolicy: 'auto' });
  try { await call('wc:sendToRoom', a.id, 'Say hello'); } catch (e) { console.log('SEND_THREW:' + e.message); }
  await new Promise(r => setTimeout(r, 30000));
  const t = await call('wc:getTranscript', a.id);
  console.log('ENTRIES:' + t.length);
  await call('wc:deleteAgent', a.id);
  app.exit(0);
})();
