import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      env: 'development',
      host: '0.0.0.0',
      port: 8080,
      accessCode: undefined,
      allowedChannels: undefined,
      trustProxy: false,
      maxRooms: 500,
      roomRetentionMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(config.dataFile).toMatch(/data[\\/]rooms\.json$/u);
  });

  it('parses overrides', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '3000',
      ACCESS_CODE: 'secret',
      ALLOWED_CHANNELS: ' #One, two ,,',
      TRUST_PROXY: 'true',
      ROOM_RETENTION_DAYS: '7',
    });
    expect(config).toMatchObject({
      env: 'production',
      port: 3000,
      accessCode: 'secret',
      allowedChannels: ['one', 'two'],
      trustProxy: true,
      roomRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it('treats an empty channel list as unrestricted', () => {
    expect(loadConfig({ ALLOWED_CHANNELS: ' , ' }).allowedChannels).toBeUndefined();
  });

  it('reports every invalid variable', () => {
    expect(() => loadConfig({ PORT: 'eighty', LOG_LEVEL: 'loud' })).toThrow(
      /PORT[\s\S]*LOG_LEVEL/u,
    );
  });
});
