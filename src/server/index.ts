import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { JsonFileStore } from './persistence/json-file-store.js';
import { RoomRegistry, roomsDocumentSchema } from './rooms/room-registry.js';
import { TwitchChatClient } from './twitch/chat-client.js';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    ...(config.env === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });

  const registry = new RoomRegistry({
    logger,
    store: new JsonFileStore({ filePath: config.dataFile, schema: roomsDocumentSchema, logger }),
    retentionMs: config.roomRetentionMs,
    maxRooms: config.maxRooms,
  });
  await registry.load();

  const chat = new TwitchChatClient({ logger });
  chat.on('message', (message) => {
    registry.routeChat(message);
  });
  const announceChatStatus = (): void => {
    registry.forEach((room) => {
      room.sendToAll({ type: 'chatStatus', connected: chat.connected });
    });
  };
  chat.on('connected', announceChatStatus);
  chat.on('disconnected', announceChatStatus);
  chat.start();

  const app = await buildApp({ config, registry, chat, logger });
  const pruneTimer = setInterval(() => registry.prune(), PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    clearInterval(pruneTimer);
    chat.stop();
    await app.close();
    await registry.shutdown();
    logger.info('Shutdown complete');
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  // Logger may not exist yet (e.g. invalid configuration), so fall back to stderr.
  process.stderr.write(
    `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
