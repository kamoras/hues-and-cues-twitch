import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonFileStore } from '../../src/server/persistence/json-file-store.js';
import { silentLogger } from '../helpers.js';

const schema = z.object({ count: z.number() });

describe('JsonFileStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hues-store-'));
    filePath = join(dir, 'nested', 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const createStore = () =>
    new JsonFileStore({ filePath, schema, logger: silentLogger, debounceMs: 10 });

  it('returns null when nothing is stored', async () => {
    await expect(createStore().load()).resolves.toBeNull();
  });

  it('coalesces scheduled saves and persists the latest value', async () => {
    const store = createStore();
    store.scheduleSave(() => ({ count: 1 }));
    store.scheduleSave(() => ({ count: 2 }));
    await store.flush();
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ count: 2 });
    await expect(createStore().load()).resolves.toEqual({ count: 2 });
  });

  it('writes after the debounce interval', async () => {
    const store = createStore();
    store.scheduleSave(() => ({ count: 7 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(createStore().load()).resolves.toEqual({ count: 7 });
  });

  it('moves invalid data aside instead of overwriting it', async () => {
    const store = createStore();
    store.scheduleSave(() => ({ count: 1 }));
    await store.flush();
    await writeFile(filePath, '{"count":"nope"}');
    await expect(store.load()).resolves.toBeNull();
    const files = await readdir(join(dir, 'nested'));
    expect(files.some((file) => file.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('flush with nothing pending is a no-op', async () => {
    await expect(createStore().flush()).resolves.toBeUndefined();
  });
});
