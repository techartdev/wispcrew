/**
 * channels-test.mjs — an unattended agent can reach its user.
 *
 * A routine that finds something at 3am used to write to a transcript nobody
 * was reading, which is the same as finding nothing.
 *
 * The design under test: the process that DECIDES to notify is often not the
 * process that CAN. A routine fires in the daemon; a desktop notification
 * needs the GUI. So every message is queued and each channel drains what it
 * can, when it can — making "the app was closed" ordinary rather than a lost
 * message.
 *
 * Offline: no network, delivery is stubbed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  channelsFor,
  clearOutbox,
  drain,
  enqueue,
  history,
  pending,
} from '@ghostbot/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-channels-'));

console.log('\n[permission] the user decides who may reach them');
{
  // No channels configured: an agent can still write to its transcript, but
  // nothing leaves the app.
  check('app is always available', channelsFor(undefined, {}).includes('app'));
  check('and nothing else by default', channelsFor(undefined, {}).length === 1);

  const global = { channels: { enabled: ['desktop'] } };
  check('a global setting applies', channelsFor(undefined, global).includes('desktop'));

  const agent = { id: 'a', name: 'A', channels: ['telegram'], createdAt: 1, updatedAt: 1 };
  const resolved = channelsFor(agent, global);
  check('an agent override wins', resolved.includes('telegram'));
  check('and replaces the global list', !resolved.includes('desktop'), JSON.stringify(resolved));

  // An agent explicitly set to stay silent must not fall back to the global
  // default — that is the whole point of setting it.
  const silent = { id: 'b', name: 'B', channels: [], createdAt: 1, updatedAt: 1 };
  check('an empty list means silence', channelsFor(silent, global).length === 1,
    JSON.stringify(channelsFor(silent, global)));
}

console.log('\n[queue] a message survives the process that made it');
{
  clearOutbox(dir);
  enqueue(dir, {
    agentId: 'agent1',
    agentName: 'Watcher',
    summary: 'The build is failing',
    body: 'Three tests broke on main.',
    channels: ['desktop', 'telegram'],
  });

  check('it is queued', pending(dir).length === 1);
  check('for both channels', pending(dir)[0].pending.length === 2);
  // Written to disk, so a crash between deciding and delivering loses nothing.
  check('and persisted', fs.existsSync(path.join(dir, 'outbox.json')));
}

console.log('\n[partial delivery] each process drains only what it can');
{
  // The daemon can reach Telegram but cannot raise a desktop notification.
  const sent = [];
  const telegramOnly = {
    id: 'telegram',
    deliver: async (m) => {
      sent.push(m.summary);
      return true;
    },
  };

  const delivered = await drain(dir, [telegramOnly]);
  check('the telegram message went', delivered === 1, String(delivered));
  check('and was the right one', sent[0] === 'The build is failing');

  const stillWaiting = pending(dir);
  check('desktop is still queued', stillWaiting.length === 1);
  check('with only desktop left', stillWaiting[0].pending.join() === 'desktop');
}

console.log('\n[later] the other process drains the rest');
{
  const shown = [];
  const desktopOnly = {
    id: 'desktop',
    deliver: async (m) => {
      shown.push(m.summary);
      return true;
    },
  };

  await drain(dir, [desktopOnly]);
  check('the desktop notification appeared', shown.length === 1);
  check('nothing is left pending', pending(dir).length === 0);
  // Delivered messages are kept so a user can see what happened while away.
  check('but it is remembered', history(dir).length === 1);
}

console.log('\n[deferred] a temporary failure keeps the message');
{
  clearOutbox(dir);
  enqueue(dir, {
    agentId: 'a', agentName: 'A', summary: 'offline test', channels: ['telegram'],
  });

  // false means "not now" — offline, timeout, a 500 from the service.
  await drain(dir, [{ id: 'telegram', deliver: async () => false }]);
  check('it stays queued', pending(dir).length === 1, 'it was dropped');

  await drain(dir, [{ id: 'telegram', deliver: async () => true }]);
  check('and goes when the network returns', pending(dir).length === 0);
}

console.log('\n[permanent] an undeliverable message does not block the rest');
{
  clearOutbox(dir);
  enqueue(dir, { agentId: 'a', agentName: 'A', summary: 'bad chat id', channels: ['telegram'] });
  enqueue(dir, { agentId: 'a', agentName: 'A', summary: 'fine', channels: ['telegram'] });

  let attempt = 0;
  await drain(dir, [
    {
      id: 'telegram',
      deliver: async () => {
        attempt++;
        // The first is rejected outright — a wrong chat id, a revoked token.
        if (attempt === 1) throw new Error('chat not found');
        return true;
      },
    },
  ]);

  check('nothing is left waiting', pending(dir).length === 0);
  const all = history(dir);
  const failed = all.find((m) => m.summary === 'bad chat id');
  check('the failure is recorded', Boolean(failed?.failures?.telegram), JSON.stringify(failed?.failures));
  check('and the next message still went', attempt === 2, String(attempt));
}

console.log('\n[bounded] the outbox cannot grow forever');
{
  clearOutbox(dir);
  for (let i = 0; i < 260; i++) {
    enqueue(dir, { agentId: 'a', agentName: 'A', summary: `message ${i}`, channels: [] });
  }
  const all = history(dir, 1000);
  check('retention is capped', all.length <= 200, String(all.length));
  // Trimming the oldest is what a user wants: recent messages matter most.
  check('the newest survive', all[0].summary === 'message 259', all[0].summary);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`CHANNELS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CHANNELS TEST PASSED\n');
