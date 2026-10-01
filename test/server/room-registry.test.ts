import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileStore } from '../../src/server/persistence/json-file-store.js';
import {
  RoomLimitError,
  RoomRegistry,
  roomsDocumentSchema,
} from '../../src/server/rooms/room-registry.js';
import { fakeClock, silentLogger } from '../helpers.js';

describe('RoomRegistry', () => {
  let dir: string;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hues-rooms-'));
    clock = fakeClock();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const createRegistry = (maxRooms = 10) =>
    new RoomRegistry({
      logger: silentLogger,
      store: new JsonFileStore({
        filePath: join(dir, 'rooms.json'),
        schema: roomsDocumentSchema,
        logger: silentLogger,
        debounceMs: 5,
      }),
      retentionMs: 1000,
      maxRooms,
      now: clock.now,
    });

  it('authenticates hosts by token', () => {
    const registry = createRegistry();
    const { room, hostToken } = registry.create('streamer');
    expect(registry.authenticateHost(room.id, hostToken)).toBe(room);
    expect(registry.authenticateHost(room.id, `${hostToken}x`)).toBeUndefined();
    expect(registry.authenticateHost('missing', hostToken)).toBeUndefined();
  });

  it('persists rooms and game state across restarts', async () => {
    const first = createRegistry();
    const { room, hostToken } = first.create('streamer');
    room.execute({ type: 'drawCard' });
    await first.shutdown();

    const second = createRegistry();
    await second.load();
    const restored = second.authenticateHost(room.id, hostToken);
    expect(restored?.channel).toBe('streamer');
    expect(restored?.snapshot().phase).toBe('picking');
    await second.shutdown();
  });

  it('routes chat only to rooms on that channel', () => {
    const registry = createRegistry();
    const a = registry.create('alpha').room;
    const b = registry.create('beta').room;
    for (const room of [a, b]) {
      room.execute({ type: 'updateSettings', settings: { guessDurationSeconds: 0 } });
      room.execute({ type: 'drawCard' });
      room.execute({ type: 'selectTarget', index: 0 });
      room.execute({ type: 'giveClue', clue: 'sky' });
    }
    registry.routeChat({
      channel: 'alpha',
      userId: '1',
      login: 'x',
      displayName: 'x',
      color: null,
      text: 'A1',
    });
    expect(a.snapshot().round?.guesses).toHaveLength(1);
    expect(b.snapshot().round?.guesses).toHaveLength(0);
    a.dispose();
    b.dispose();
  });

  it('prunes idle rooms without connected clients', () => {
    const registry = createRegistry();
    const idle = registry.create('idle_room').room;
    const watched = registry.create('watched').room;
    watched.attach({ role: 'overlay', send: () => undefined });
    clock.advance(5000);
    expect(registry.prune()).toBe(1);
    expect(registry.get(idle.id)).toBeUndefined();
    expect(registry.get(watched.id)).toBe(watched);
    watched.dispose();
  });

  it('enforces the room limit after pruning', () => {
    const registry = createRegistry(1);
    registry.create('one');
    expect(() => registry.create('two')).toThrow(RoomLimitError);
    clock.advance(5000);
    expect(() => registry.create('two')).not.toThrow();
  });
});
