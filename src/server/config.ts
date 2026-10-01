import { resolve } from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const channelList = z.string().transform((value) =>
  value
    .split(',')
    .map((channel) => channel.trim().replace(/^#/u, '').toLowerCase())
    .filter((channel) => channel !== ''),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_DIR: z.string().default('./data'),
  /** If set, creating a room requires this code (keeps strangers off your server). */
  ACCESS_CODE: z.string().min(1).optional(),
  /** If set, only these Twitch channels may have rooms. Comma-separated. */
  ALLOWED_CHANNELS: channelList.optional(),
  /** Set when running behind a reverse proxy (Caddy, nginx) so client IPs are correct. */
  TRUST_PROXY: booleanString.default(false),
  ROOM_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  MAX_ROOMS: z.coerce.number().int().min(1).default(500),
  /** Directory of built client assets. */
  PUBLIC_DIR: z.string().default('./dist/public'),
});

export interface AppConfig {
  readonly env: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly dataFile: string;
  readonly publicDir: string;
  readonly accessCode: string | undefined;
  readonly allowedChannels: readonly string[] | undefined;
  readonly trustProxy: boolean;
  readonly roomRetentionMs: number;
  readonly maxRooms: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const values = parsed.data;
  const allowed = values.ALLOWED_CHANNELS;
  return {
    env: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    dataFile: resolve(values.DATA_DIR, 'rooms.json'),
    publicDir: resolve(values.PUBLIC_DIR),
    accessCode: values.ACCESS_CODE,
    allowedChannels: allowed && allowed.length > 0 ? allowed : undefined,
    trustProxy: values.TRUST_PROXY,
    roomRetentionMs: values.ROOM_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    maxRooms: values.MAX_ROOMS,
  };
}
