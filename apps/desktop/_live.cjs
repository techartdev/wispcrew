/**
 * A real multi-agent conversation, with a real model.
 *
 * Confirms the fix: `runPrompt` now writes into the ROOM's transcript
 * rather than the agent's own file. Before it, `@all` ran two agents and
 * the room showed nothing, because the second agent's replies went into a
 * file nobody was reading.
 *
 * Throwaway profile seeded with credentials only.
 */
const { app, ipcMain } = require('electron');
const fs = require('fs');

const orig = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn);
  return orig(channel, fn);
};

/** Wait for the room to fall quiet rather than for a fixed time. */
async function settle(call, roomId, timeoutMs = 150_000) {
  let previous = '';
  let stable = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stable < 3) {
    await new Promise((r) => setTimeout(r, 3000));
    const transcript = await call('wc:getTranscript', roomId);
    const signature = transcript
      .filter((e) => e.kind === 'message' && e.role === 'assistant')
      .map((e) => `${e.id}:${(e.content ?? '').length}`)
      .join('|');
    stable = signature === previous && signature.length > 0 ? stable + 1 : 0;
    previous = signature;
  }
  return call('wc:getTranscript', roomId);
}

(async () => {
  const out = [];
  try {
    await import('./dist/main.mjs');
    await app.whenReady();
    await new Promise((r) => setTimeout(r, 6000));

    const call = (c, ...a) => handlers.get(c)({}, ...a);
    out.push('provider: ' + (await call('wc:getSettings')).presetId);

    // Two agents whose jobs differ obviously, so who answered is visible in
    // the content rather than only in the metadata.
    const sums = await call('wc:createAgent', {
      name: 'Sums',
      description: 'You answer arithmetic only. Reply with just the number, nothing else.',
      approvalPolicy: 'readonly',
    });
    const colours = await call('wc:createAgent', {
      name: 'Colours',
      description: 'You answer about colours only. Reply with just one colour word.',
      approvalPolicy: 'readonly',
    });

    const room = (await call('wc:listConversations')).find((r) => r.id === sums.id);
    if (!room) throw new Error('a newly created agent has no room');

    await call('wc:addRoomAgent', room.id, colours.id);
    const withBoth = (await call('wc:listConversations')).find((r) => r.id === room.id);
    out.push(
      'handles : ' +
        withBoth.participants.filter((p) => p.kind === 'agent').map((p) => '@' + p.handle).join(', '),
    );

    const after = (t, from) =>
      t
        .filter((e) => e.kind === 'message' && e.role === 'assistant' && e.createdAt > from)
        .map((e) => (e.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 44));

    let mark = Date.now();
    await call('wc:sendToRoom', room.id, '@sums what is 2 + 2?');
    let r = after(await settle(call, room.id), mark);
    out.push('');
    out.push('[tagged @sums]       ' + r.length + ' reply');
    for (const x of r) out.push('   "' + x + '"');

    mark = Date.now();
    await call('wc:sendToRoom', room.id, 'and 10 + 5?');
    r = after(await settle(call, room.id), mark);
    out.push('');
    out.push('[untagged follow-up] ' + r.length + ' reply');
    for (const x of r) out.push('   "' + x + '"');

    mark = Date.now();
    await call('wc:sendToRoom', room.id, '@all name your speciality in one word');
    r = after(await settle(call, room.id), mark);
    out.push('');
    out.push('[@all]               ' + r.length + ' replies');
    for (const x of r) out.push('   "' + x + '"');

    await call('wc:deleteAgent', sums.id);
    await call('wc:deleteAgent', colours.id);
    out.push('');
    out.push('cleanup: probe agents removed');
  } catch (err) {
    out.push('ERROR: ' + err.message);
  }
  fs.writeFileSync('D:/Mine/OpenAgent/live.txt', out.join('\n'));
  app.exit(0);
})();
