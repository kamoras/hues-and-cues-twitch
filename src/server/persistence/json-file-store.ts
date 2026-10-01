import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { z } from 'zod';

export interface JsonFileStoreOptions<Schema extends z.ZodType> {
  readonly filePath: string;
  readonly schema: Schema;
  readonly logger: Logger;
  /** Coalesces bursts of changes into one write. */
  readonly debounceMs?: number;
}

/**
 * Durable single-document JSON storage.
 *
 * Writes go to a temporary file which is then atomically renamed over the
 * target, so a crash mid-write never leaves a truncated document. Reads are
 * validated against a zod schema; an unreadable file is preserved under a
 * `.corrupt-<timestamp>` name rather than silently overwritten.
 */
export class JsonFileStore<Schema extends z.ZodType> {
  private readonly filePath: string;
  private readonly schema: Schema;
  private readonly logger: Logger;
  private readonly debounceMs: number;

  private timer: NodeJS.Timeout | null = null;
  private pending: (() => z.input<Schema>) | null = null;
  private writing: Promise<void> = Promise.resolve();

  public constructor(options: JsonFileStoreOptions<Schema>) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.logger = options.logger.child({ component: 'store', file: options.filePath });
    this.debounceMs = options.debounceMs ?? 1000;
  }

  /** Loads the document, or returns `null` if it does not exist or is invalid. */
  public async load(): Promise<z.output<Schema> | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }

    try {
      return this.schema.parse(JSON.parse(raw));
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${String(Date.now())}`;
      this.logger.error({ err: error, backup }, 'Stored data is invalid; moving it aside');
      await rename(this.filePath, backup);
      return null;
    }
  }

  /** Schedules a write. `produce` is called lazily so only the latest state is serialised. */
  public scheduleSave(produce: () => z.input<Schema>): void {
    this.pending = produce;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Writes any pending change immediately. Safe to call concurrently. */
  public async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const produce = this.pending;
    this.pending = null;
    if (produce === null) {
      await this.writing;
      return;
    }
    const write = this.writing.then(() => this.write(produce()));
    this.writing = write.catch((error: unknown) => {
      this.logger.error({ err: error }, 'Failed to persist data');
    });
    await this.writing;
  }

  private async write(document: z.input<Schema>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.filePath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
