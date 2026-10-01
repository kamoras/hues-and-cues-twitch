import type { Logger } from 'pino';
import { z } from 'zod';
import { gameSnapshotSchema } from '../game/snapshot.js';
import type { JsonFileStore } from '../persistence/json-file-store.js';
import type { ChatMessage } from '../twitch/chat-client.js';
import { Room } from './room.js';
import { hashToken, randomId, verifyToken } from './tokens.js';

const roomRecordSchema = z.object({
  id: z.string(),
  channel: z.string(),
  hostTokenHash: z.string(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  game: gameSnapshotSchema,
});

export const roomsDocumentSchema = z.object({
  version: z.literal(1),
  rooms: z.array(roomRecordSchema),
});
type RoomsDocument = z.infer<typeof roomsDocumentSchema>;

export interface RoomRegistryOptions {
  readonly logger: Logger;
  /** Where rooms are persisted. Omit for in-memory only (tests). */
  readonly store?: JsonFileStore<typeof roomsDocumentSchema>;
  /** Rooms untouched for longer than this are deleted. */
  readonly retentionMs: number;
  readonly maxRooms: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface CreatedRoom {
  readonly room: Room;
  /** Shown once to the creator; only its hash is stored. */
  readonly hostToken: string;
}

export class RoomLimitError extends Error {
  public constructor() {
    super('This server has reached its room limit.');
    this.name = 'RoomLimitError';
  }
}

/** Owns every room, routes chat to them and persists them. */
export class RoomRegistry {
  private readonly logger: Logger;
  private readonly store: JsonFileStore<typeof roomsDocumentSchema> | undefined;
  private readonly retentionMs: number;
  private readonly maxRooms: number;
  private readonly now: () => number;
  private readonly random: (() => number) | undefined;
  private readonly rooms = new Map<string, Room>();

  public constructor(options: RoomRegistryOptions) {
    this.logger = options.logger.child({ component: 'rooms' });
    this.store = options.store;
    this.retentionMs = options.retentionMs;
    this.maxRooms = options.maxRooms;
    this.now = options.now ?? Date.now;
    this.random = options.random;
  }

  public get size(): number {
    return this.rooms.size;
  }

  public async load(): Promise<void> {
    const document = await this.store?.load();
    if (!document) return;
    for (const record of document.rooms) {
      this.rooms.set(record.id, this.instantiate({ ...record, snapshot: record.game }));
    }
    this.logger.info({ rooms: this.rooms.size }, 'Loaded rooms');
    this.prune();
  }

  public create(channel: string): CreatedRoom {
    this.prune();
    if (this.rooms.size >= this.maxRooms) {
      throw new RoomLimitError();
    }
    const hostToken = randomId(32);
    const now = this.now();
    const room = this.instantiate({
      id: randomId(12),
      channel,
      hostTokenHash: hashToken(hostToken),
      createdAt: now,
      lastActiveAt: now,
    });
    this.rooms.set(room.id, room);
    this.persist();
    this.logger.info({ room: room.id, channel }, 'Room created');
    return { room, hostToken };
  }

  public get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  public authenticateHost(id: string, token: string): Room | undefined {
    const room = this.rooms.get(id);
    return room && verifyToken(token, room.hostTokenHash) ? room : undefined;
  }

  public routeChat(message: ChatMessage): void {
    for (const room of this.rooms.values()) {
      if (room.channel === message.channel) room.handleChat(message);
    }
  }

  public forEach(callback: (room: Room) => void): void {
    this.rooms.forEach(callback);
  }

  /** Removes rooms that have been inactive past the retention period. */
  public prune(): number {
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    for (const [id, room] of this.rooms) {
      if (room.clientCount === 0 && room.lastActiveAt < cutoff) {
        room.dispose();
        this.rooms.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.logger.info({ removed }, 'Pruned inactive rooms');
      this.persist();
    }
    return removed;
  }

  public async shutdown(): Promise<void> {
    this.persist();
    await this.store?.flush();
    for (const room of this.rooms.values()) room.dispose();
  }

  private instantiate(record: {
    id: string;
    channel: string;
    hostTokenHash: string;
    createdAt: number;
    lastActiveAt: number;
    snapshot?: z.infer<typeof gameSnapshotSchema>;
  }): Room {
    return new Room({
      ...record,
      logger: this.logger,
      now: this.now,
      ...(this.random ? { random: this.random } : {}),
      onChange: () => {
        this.persist();
      },
    });
  }

  private persist(): void {
    this.store?.scheduleSave((): RoomsDocument => ({
      version: 1,
      rooms: [...this.rooms.values()].map((room) => ({
        id: room.id,
        channel: room.channel,
        hostTokenHash: room.hostTokenHash,
        createdAt: room.createdAt,
        lastActiveAt: room.lastActiveAt,
        game: room.snapshot(),
      })),
    }));
  }
}
