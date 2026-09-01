/** Carry both the id and the handle for each room-mate. */
const fs = require('fs');

/* App: build {id, handle} pairs. */
{
  const f = 'apps/desktop/src/renderer/App.tsx';
  let t = fs.readFileSync(f, 'utf8');

  t = t.replace(
    '  const companions = useMemo(() => {\n    const map: Record<string, string[]> = {};',
    `  const companions = useMemo(() => {
    /*
     * The id AND the handle: the id seeds each room-mate's avatar, the
     * handle is what the row shows. Carrying only handles meant the stacked
     * avatar had nothing stable to draw the other members from.
     */
    const map: Record<string, { id: string; handle: string }[]> = {};`,
  );

  t = t.replace(
    '        map[self.id] = members.filter((p) => p.id !== self.id).map((p) => p.handle);',
    `        map[self.id] = members
          .filter((p) => p.id !== self.id)
          .map((p) => ({ id: p.id, handle: p.handle }));`,
  );

  fs.writeFileSync(f, t, 'utf8');
  console.log('App pairs   :', t.includes('{ id: p.id, handle: p.handle }'));
}

/* Sidebar: accept the pairs and split them where used. */
{
  const f = 'apps/desktop/src/renderer/Sidebar.tsx';
  let t = fs.readFileSync(f, 'utf8');

  t = t.replace(
    '  companions?: Record<string, string[]>;',
    '  companions?: Record<string, { id: string; handle: string }[]>;',
  );

  t = t.replace(
    '          const roomMates = companions?.[agent.id] ?? [];',
    `          const roomMates = companions?.[agent.id] ?? [];
          const roomMateIds = roomMates.map((m) => m.id);
          // Any state other than idle counts as occupied for the avatar's
          // motion; the exact state is already shown by the dot beside it.
          const active = state !== 'idle';`,
  );

  t = t.replace(
    'with {roomMates.map((h) => `@${h}`).join(\', \')}',
    'with {roomMates.map((m) => `@${m.handle}`).join(\', \')}',
  );

  t = t.split("busy={state === 'working' || state === 'thinking'}").join('busy={active}');

  fs.writeFileSync(f, t, 'utf8');
  console.log('Sidebar type:', t.includes('{ id: string; handle: string }[]'));
  console.log('Sidebar ids :', t.includes('roomMateIds'));
  console.log('Sidebar busy:', t.includes('busy={active}'));
}
