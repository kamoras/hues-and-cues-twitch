import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type {
  CreateRoomResponse,
  HostGameState,
  ServerMessage,
} from '../../src/shared/protocol.js';
import { buildApp } from '../../src/server/http/app.js';
import { RoomRegistry } from '../../src/server/rooms/room-registry.js';
import { silentLogger } from '../helpers.js';

class FakeChat {
  public connected = true;
  public readonly refs = new Map<string, number>();
  public acquire(channel: string): void {
    this.refs.set(channel, (this.refs.get(channel) ?? 0) + 1);
  }
  public release(channel: string): void {
    this.refs.set(channel, (this.refs.get(channel) ?? 0) - 1);
  }
}

/** A WebSocket test client that buffers messages so none are missed. */
class TestClient {
  private readonly queue: ServerMessage[] = [];
  private waiters: (() => void)[] = [];
  public closeCode: number | null = null;
  private readonly closed: Promise<void>;

  private constructor(public readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.queue.push(JSON.parse((data as Buffer).toString('utf8')) as ServerMessage);
      this.notify();
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code) => {
        this.closeCode = code;
        this.notify();
        resolve();
      });
    });
  }

  public static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return client;
  }

  public send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the next message matching `predicate`, discarding others. */
  public async next(
    predicate: (message: ServerMessage) => boolean = () => true,
  ): Promise<ServerMessage> {
    for (;;) {
      const index = this.queue.findIndex(predicate);
      const [match] = index === -1 ? [] : this.queue.splice(index, 1);
      if (match) return match;
      if (this.closeCode !== null) throw new Error(`socket closed (${String(this.closeCode)})`);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  public async nextState(
    predicate: (state: HostGameState) => boolean = () => true,
  ): Promise<HostGameState> {
    const message = await this.next(
      (m) => m.type === 'state' && predicate(m.state as HostGameState),
    );
    return (message as Extract<ServerMessage, { type: 'state' }>).state as HostGameState;
  }

  public async waitForClose(): Promise<number | null> {
    await this.closed;
    return this.closeCode;
  }

  public close(): void {
    this.socket.close();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

describe('HTTP + WebSocket API', () => {
  let app: FastifyInstance;
  let registry: RoomRegistry;
  let chat: FakeChat;
  let wsUrl: string;
  const clients: TestClient[] = [];

  const setup = async (config: { accessCode?: string; allowedChannels?: string[] } = {}) => {
    registry = new RoomRegistry({ logger: silentLogger, retentionMs: 60_000, maxRooms: 3 });
    chat = new FakeChat();
    app = await buildApp({
      config: {
        accessCode: config.accessCode,
        allowedChannels: config.allowedChannels,
        publicDir: '/nonexistent',
        trustProxy: false,
        env: 'test',
      },
      registry,
      chat,
      logger: silentLogger,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${String(port)}/ws`;
  };

  const createRoom = async (channel = 'Streamer'): Promise<CreateRoomResponse> => {
    const response = await app.inject({ method: 'POST', url: '/api/rooms', payload: { channel } });
    expect(response.statusCode).toBe(201);
    return response.json<CreateRoomResponse>();
  };

  const connect = async (hello: Record<string, unknown>): Promise<TestClient> => {
    const client = await TestClient.connect(wsUrl);
    clients.push(client);
    client.send({ type: 'hello', ...hello });
    return client;
  };

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await app.close();
    await registry.shutdown();
  });

  describe('REST', () => {
    beforeEach(() => setup());

    it('reports health', async () => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.json()).toEqual({ status: 'ok', chatConnected: true, rooms: 0 });
    });

    it('creates rooms with a normalised channel and secret token', async () => {
      const room = await createRoom('#MyChannel');
      expect(room.channel).toBe('mychannel');
      expect(room.roomId).toMatch(/^[\w-]{16}$/u);
      expect(room.hostToken.length).toBeGreaterThanOrEqual(40);
      const info = await app.inject({ method: 'GET', url: `/api/rooms/${room.roomId}` });
      expect(info.json()).toEqual({ roomId: room.roomId, channel: 'mychannel' });
    });

    it('validates channel names', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { channel: 'no spaces!' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'bad_request' });
    });

    it('returns 404 for unknown rooms', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/rooms/doesnotexist' });
      expect(response.statusCode).toBe(404);
    });

    it('enforces the room limit', async () => {
      await createRoom('one_1');
      await createRoom('two_2');
      await createRoom('three_3');
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { channel: 'four_4' },
      });
      expect(response.statusCode).toBe(503);
    });

    it('sets security headers', async () => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('access control', () => {
    it('requires the access code when configured', async () => {
      await setup({ accessCode: 'letmein' });
      expect((await app.inject({ method: 'GET', url: '/api/config' })).json()).toEqual({
        accessCodeRequired: true,
      });
      const denied = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { channel: 'abc' },
      });
      expect(denied.statusCode).toBe(401);
      const allowed = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { channel: 'abc', accessCode: 'letmein' },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('restricts channels when configured', async () => {
      await setup({ allowedChannels: ['allowed'] });
      const denied = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { channel: 'other' },
      });
      expect(denied.statusCode).toBe(403);
      const allowed = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { channel: 'Allowed' },
      });
      expect(allowed.statusCode).toBe(201);
    });
  });

  describe('WebSocket game flow', () => {
    beforeEach(() => setup());

    it('plays a full round, hiding the target from the overlay until reveal', async () => {
      const room = await createRoom();
      const host = await connect({ role: 'host', roomId: room.roomId, token: room.hostToken });
      const overlay = await connect({ role: 'overlay', roomId: room.roomId });
      await host.next((m) => m.type === 'welcome');
      await overlay.next((m) => m.type === 'welcome');
      expect(chat.refs.get('streamer')).toBe(2);

      host.send({ type: 'updateSettings', settings: { useSecondClue: false } });
      host.send({ type: 'drawCard' });
      const picking = await host.nextState((s) => s.phase === 'picking');
      expect(picking.card).toHaveLength(4);

      host.send({ type: 'selectTarget', index: 2 });
      const selected = await host.nextState((s) => s.target !== null);
      const target = selected.target;
      if (!target) throw new Error('target missing');

      host.send({ type: 'giveClue', clue: 'ocean' });
      const overlayGuessing = await overlay.nextState((s) => s.phase === 'guessing');
      expect(overlayGuessing.clues).toEqual(['ocean']);
      expect(overlayGuessing).not.toHaveProperty('target');
      expect(overlayGuessing).not.toHaveProperty('card');

      registry.routeChat({
        channel: 'streamer',
        userId: '1',
        login: 'viewer',
        displayName: 'Viewer',
        color: null,
        text: `${'ABCDEFGHIJKLMNOP'.charAt(target.row)}${String(target.col + 1)}`,
      });
      await overlay.nextState((s) => s.totalGuesses === 1);

      host.send({ type: 'closeGuessing' });
      const revealed = await overlay.nextState((s) => s.phase === 'reveal');
      expect(revealed.lastResult?.target).toEqual(target);
      expect(revealed.leaderboard).toEqual([
        { userId: '1', displayName: 'Viewer', color: null, score: 3 },
      ]);
    });

    it('reports invalid commands without dropping the connection', async () => {
      const room = await createRoom();
      const host = await connect({ role: 'host', roomId: room.roomId, token: room.hostToken });
      await host.next((m) => m.type === 'welcome');
      host.send({ type: 'closeGuessing' });
      expect(await host.next((m) => m.type === 'error')).toMatchObject({ code: 'invalid_state' });
      host.send({ type: 'explode' });
      expect(await host.next((m) => m.type === 'error')).toMatchObject({ code: 'bad_request' });
      host.send({ type: 'drawCard' });
      await host.nextState((s) => s.phase === 'picking');
    });

    it('rejects a bad host token', async () => {
      const room = await createRoom();
      const host = await connect({ role: 'host', roomId: room.roomId, token: 'x'.repeat(43) });
      expect(await host.waitForClose()).toBe(4401);
    });

    it('rejects unknown rooms and malformed hellos', async () => {
      const overlay = await connect({ role: 'overlay', roomId: 'missing-room' });
      expect(await overlay.waitForClose()).toBe(4404);
      const bad = await connect({ role: 'admin' });
      expect(await bad.waitForClose()).toBe(4400);
    });

    it('keeps overlays read-only', async () => {
      const room = await createRoom();
      const overlay = await connect({ role: 'overlay', roomId: room.roomId });
      await overlay.next((m) => m.type === 'welcome');
      overlay.send({ type: 'drawCard' });
      expect(await overlay.next((m) => m.type === 'error')).toMatchObject({ code: 'unauthorized' });
    });

    it('releases the chat channel when clients disconnect', async () => {
      const room = await createRoom();
      const overlay = await connect({ role: 'overlay', roomId: room.roomId });
      await overlay.next((m) => m.type === 'welcome');
      overlay.close();
      await overlay.waitForClose();
      await expect.poll(() => chat.refs.get('streamer')).toBe(0);
    });
  });
});
