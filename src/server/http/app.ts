import { existsSync } from 'node:fs';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  type ApiErrorResponse,
  type CreateRoomResponse,
  createRoomRequestSchema,
  type RoomInfoResponse,
} from '../../shared/protocol.js';
import type { AppConfig } from '../config.js';
import { RoomLimitError, type RoomRegistry } from '../rooms/room-registry.js';
import { safeEqual } from '../rooms/tokens.js';
import type { TwitchChatClient } from '../twitch/chat-client.js';
import { MAX_WS_PAYLOAD_BYTES, registerWsGateway } from './ws-gateway.js';

export interface AppDependencies {
  readonly config: Pick<
    AppConfig,
    'accessCode' | 'allowedChannels' | 'publicDir' | 'trustProxy' | 'env'
  >;
  readonly registry: RoomRegistry;
  readonly chat: Pick<TwitchChatClient, 'acquire' | 'release' | 'connected'>;
  readonly logger: Logger;
}

/** Pages served from the client build, keyed by their clean URL. */
const PAGES: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/control': 'control.html',
  '/overlay': 'overlay.html',
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, registry, chat } = deps;
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: config.trustProxy,
    bodyLimit: 4 * 1024,
  });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        scriptSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    // OBS's browser source is not cross-origin isolated; keep defaults permissive enough.
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
    }
    const body: ApiErrorResponse = {
      error: statusCode >= 500 ? 'Internal server error' : (error as Error).message,
      code: statusCode === 429 ? 'rate_limited' : statusCode >= 500 ? 'internal' : 'bad_request',
    };
    return reply.status(statusCode).send(body);
  });

  // Health checks run every few seconds; keep them out of the request log.
  app.get('/healthz', { logLevel: 'warn' }, () => ({
    status: 'ok',
    chatConnected: chat.connected,
    rooms: registry.size,
  }));

  app.post(
    '/api/rooms',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = createRoomRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Invalid request';
        return reply
          .status(400)
          .send({ error: message, code: 'bad_request' } satisfies ApiErrorResponse);
      }
      const { channel, accessCode } = parsed.data;
      if (config.accessCode !== undefined && !safeEqual(accessCode ?? '', config.accessCode)) {
        return reply.status(401).send({
          error: 'Incorrect access code.',
          code: 'unauthorized',
        } satisfies ApiErrorResponse);
      }
      if (config.allowedChannels && !config.allowedChannels.includes(channel)) {
        return reply.status(403).send({
          error: 'This server is not configured for that channel.',
          code: 'unauthorized',
        } satisfies ApiErrorResponse);
      }
      try {
        const { room, hostToken } = registry.create(channel);
        return await reply.status(201).send({
          roomId: room.id,
          hostToken,
          channel: room.channel,
        } satisfies CreateRoomResponse);
      } catch (error) {
        if (error instanceof RoomLimitError) {
          return reply
            .status(503)
            .send({ error: error.message, code: 'internal' } satisfies ApiErrorResponse);
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { roomId: string } }>('/api/rooms/:roomId', (request, reply) => {
    const room = registry.get(request.params.roomId);
    if (!room) {
      return reply
        .status(404)
        .send({ error: 'Room not found.', code: 'not_found' } satisfies ApiErrorResponse);
    }
    return { roomId: room.id, channel: room.channel } satisfies RoomInfoResponse;
  });

  app.get('/api/config', () => ({ accessCodeRequired: config.accessCode !== undefined }));

  registerWsGateway(app, { registry, chat, logger: deps.logger });

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      index: false,
      wildcard: true,
      maxAge: config.env === 'production' ? '1h' : 0,
      setHeaders: (response, filePath) => {
        if (filePath.includes('/assets/')) {
          response.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.html')) {
          response.header('Cache-Control', 'no-cache');
        }
      },
    });
    for (const [url, file] of Object.entries(PAGES)) {
      app.get(url, (_request, reply) => reply.header('Cache-Control', 'no-cache').sendFile(file));
    }
  } else {
    deps.logger.warn(
      { publicDir: config.publicDir },
      'Client build not found; run `npm run build:client` (or use `npm run dev`).',
    );
  }

  return app;
}
