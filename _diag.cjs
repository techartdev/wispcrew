/**
 * Dump a room transcript entry by entry.
 *
 * The summarised probe said "0 replies" for a follow-up without showing
 * what the room actually contains. Guessing from a count is how I have
 * already been wrong twice here.
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
    await new Promise((r) => setTimeout(r, 6000));

    const call = (c, ...a) => handlers.get(c)({}, ...a);

    // `auto`, so a tool call is not the thing being measured.
    const sums = await call('wc:createAgent', {
      name: 'Sums',
      description: 'Answer arithmetic from your own knowledge. Never use tools. Reply with just the number.',
      approvalPolicy: 'auto',
    });
    const colours = await call('wc:createAgent', {
      name: 'Colours',
      description: 'Answer about colours from your own knowledge. Never use tools. Reply with one word.',
      approvalPolicy: 'auto',
    });

    const room = (await call('wc:listConversations')).find((r) => r.id === sums.id);
    await call('wc:addRoomAgent', room.id, colours.id);

    const wait = async (ms) => new Promise((r) => setTimeout(r, ms));

    await call('wc:sendToRoom', room.id, '@sums what is 2 + 2?');
    await wait(45000);
    await call('wc:sendToRoom', room.id, 'and 10 + 5?');
    await wait(45000);
    await call('wc:sendToRoom', room.id, '@all name a colour or a number');
    await wait(60000);

    const transcript = await call('wc:getTranscript', room.id);
    out.push('room transcript, ' + transcript.length + ' entries:');
    for (const e of transcript) {
      const who = e.authorId ? ` [${e.authorId}]` : '';
      const body = String(e.content ?? e.text ?? '').replace(/\s+/g, ' ').slice(0, 70);
      out.push(`  ${e.kind}/${e.role ?? e.level ?? ''}${who}: ${body}`);
    }

    const conv = (await call('wc:listConversations')).find((r) => r.id === room.id);
    out.push('');
    out.push('lastAddressed: ' + JSON.stringify(conv.lastAddressed ?? {}));

    await call('wc:deleteAgent', sums.id);
    await call('wc:deleteAgent', colours.id);
  } catch (err) {
    out.push('ERROR: ' + err.message + '\n' + (err.stack ?? '').split('\n').slice(0, 3).join('\n'));
  }
  fs.writeFileSync('D:/Mine/OpenAgent/diag.txt', out.join('\n'));
  app.exit(0);
})();
