import type { Db, PgBoss } from 'pg-boss';
import type { EntityManager } from 'typeorm';

/**
 * The started pg-boss instance. `import type` is erased at compile time, so
 * naming the ESM-only package here costs no runtime require.
 */
export type PgBossInstance = PgBoss;

/** Injection token for the started `PgBoss` instance. */
export const PG_BOSS = 'PG_BOSS';

/** Queue names. Kept here so publisher and consumer cannot drift apart. */
export const QUEUE_NAMES = {
  VIDEO_PROCESS: 'video.process',
  UPLOAD_SWEEP: 'upload.sweep',
} as const;

export interface VideoProcessJobData {
  videoId: string;
}

export type UploadSweepJobData = Record<string, never>;

export interface QueueJobDataMap {
  [QUEUE_NAMES.VIDEO_PROCESS]: VideoProcessJobData;
  [QUEUE_NAMES.UPLOAD_SWEEP]: UploadSweepJobData;
}

/**
 * Adapts a TypeORM `EntityManager` to pg-boss's `Db` interface so an enqueue can
 * ride along inside an open transaction.
 *
 * The wrapping is the whole point: pg-boss expects `{ rows }`, while TypeORM's
 * `manager.query()` resolves to the row array itself. Handing pg-boss the
 * manager unwrapped fails deep inside its SQL layer with an unhelpful error.
 */
export function toPgBossDb(manager: EntityManager): Db {
  return {
    executeSql: async (text: string, values: unknown[] = []) => ({
      rows: await manager.query(text, values),
    }),
  };
}
