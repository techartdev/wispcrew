/**
 * Does a multi-agent room survive being closed and reopened?
 *
 * Every live check so far has been one process, one session. A user closes
 * the app. The daemon keeps running, the desktop reconnects, and everything
 * built this month — rooms, handles, turns, last-addressed — has to still be
 * there and still work.
 *
 * This is the gate on step 5: "only if the earlier steps land cleanly".
 * Cleanly is a claim about behaviour under ordinary use, not about whether
 * the suites pass.
 *
 * Throwaway profile seeded with credentials.
 */
const { app, ipcMain } = require('electron');
const fs = require('fs');

const orig = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn);
  return orig(channel, fn);
};

async function waitForReplies(call, roomId, mark, expected, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const transcript = await call('wc:getTranscript', roomId);
    const replies = transcript.filter(
      (e) => e.kind === 'message' && e.role === 'assistant' && e.createdAt > mark,
    );
    const signature = replies.map((e) => `${e.id}:${(e.content ?? '').length}`).join('|');
    if (replies.length >= expected) {
      stable = signature === previous ? stable + 1 : 0;
      if (stable >= 2) return replies;
    }
    previous = signature;
  }
  const transcript = await call('wc:getTranscript', roomId);
  return transcript.filter(
    (e) => e.kind === 'message' && e.role === 'assistant' && e.createdAt > mark,
  );
}

(async () => {
  const out = [];
  const phase = process.env.SOAK_PHASE;

  try {
    await import('./dist/main.mjs');
    await app.whenReady();
    await new Promise((r) => setTimeout(r, 6000));

    const call = (c, ...a) => handlers.get(c)({}, ...a);
    const rt = await import('@wispcrew/runtime');

    if (phase === 'setup') {
      /* Build a two-agent room and use it. */
      const sums = await call('wc:createAgent', {
        name: 'Sums',
        description: 'You answer arithmetic only. Reply with just the number.',
        approvalPolicy: 'auto',
      });
      const colours = await call('wc:createAgent', {
        name: 'Colours',
        description: 'You answer about colours only. Reply with one colour word.',
        approvalPolicy: 'auto',
      });

      const room = (await call('wc:listConversations')).find((r) => r.id === sums.id);
      await call('wc:addRoomAgent', room.id, colours.id);
      await call('wc:setRoomMode', room.id, 'open');

      // Bind a Telegram endpoint, so that survives too.
      rt.bindEndpoint({
        conversationId: room.id,
        endpoint: { chatId: '999', threadId: 7 },
        label: 'soak topic',
      });

      const mark = Date.now();
      await call('wc:sendToRoom', room.id, '@sums what is 3 + 4?');
      const replies = await waitForReplies(call, room.id, mark, 1);

      out.push('SETUP');
      out.push('  room      : ' + room.id);
      out.push('  replies   : ' + replies.length);
      for (const r of replies) out.push('    "' + (r.content ?? '').trim().slice(0, 40) + '"');

      const after = (await call('wc:listConversations')).find((r) => r.id === room.id);
      out.push('  addressed : ' + JSON.stringify(after.lastAddressed ?? {}));
      out.push('  turns     : ' + rt.listTurns(room.id).length);

      fs.writeFileSync(process.env.SOAK_ROOM_FILE, room.id);
    } else {
      /* Reopen: is everything still here, and does it still work? */
      const roomId = fs.readFileSync(process.env.SOAK_ROOM_FILE, 'utf8').trim();
      const room = (await call('wc:listConversations')).find((r) => r.id === roomId);

      out.push('AFTER RESTART');
      if (!room) {
        out.push('  ROOM GONE');
      } else {
        const agents = room.participants.filter((p) => p.kind === 'agent');
        out.push('  room      : "' + room.title + '" [' + room.mode + ']');
        out.push('  handles   : ' + agents.map((p) => '@' + p.handle).join(', '));
        out.push('  addressed : ' + JSON.stringify(room.lastAddressed ?? {}));

        const transcript = await call('wc:getTranscript', roomId);
        out.push('  transcript: ' + transcript.length + ' entries');
        out.push('  turns     : ' + rt.listTurns(roomId).length);

        const binding = rt.conversationFor({ chatId: '999', threadId: 7 });
        out.push('  telegram  : ' + (binding === roomId ? 'still bound' : 'LOST'));

        /*
         * The real question: does an UNTAGGED follow-up still continue with
         * the agent addressed before the restart? That depends on
         * lastAddressed surviving, which is the sort of thing that quietly
         * does not.
         */
        const mark = Date.now();
        await call('wc:sendToRoom', roomId, 'and what is 10 + 1?');
        const replies = await waitForReplies(call, roomId, mark, 1);

        out.push('  follow-up : ' + replies.length + ' reply');
        for (const r of replies) out.push('    "' + (r.content ?? '').trim().slice(0, 40) + '"');
      }
    }
  } catch (err) {
    out.push('ERROR: ' + err.message);
  }

  fs.appendFileSync(process.env.SOAK_OUT, out.join('\n') + '\n\n');
  app.exit(0);
})();
