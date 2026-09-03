import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Db, JobWithMetadata } from 'pg-boss';
import queueConfig from '../config/queue.config';
import { forgetBoss } from './queue.module';
import {
  PG_BOSS,
  type PgBossInstance,
  type QueueJobDataMap,
} from './queue.types';

export interface SendJobOptions {
  /** Bind the enqueue to an open transaction — see `toPgBossDb`. */
  db?: Db;
  retryLimit?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
  singletonKey?: string;
}

/**
 * A job as the worker sees it. pg-boss's own type, so `includeMetadata: true`
 * below type-checks without a cast and the handler really does get `retryCount`
 * and `retryLimit`.
 */
export type WorkJob<T extends object> = JobWithMetadata<T>;

export interface EnsureQueueOptions {
  retryLimit?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
}

/**
 * Typed wrapper over the pg-boss instance. Everything that publishes or
 * schedules work goes through here so job names and payload shapes stay in
 * `queue.types.ts` rather than scattered across callers.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBossInstance,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * pg-boss keeps polling timers and a connection pool alive; without this the
   * process (or a Jest run) never settles. `stop()` is idempotent, so it is safe
   * even when several modules share the cached boss.
   */
  async onModuleDestroy(): Promise<void> {
    await this.boss.stop({ graceful: false, close: true });
    forgetBoss(this.boss);
  }

  /** Idempotent: pg-boss ignores a `createQueue` for a queue that exists. */
  async ensureQueue(
    name: keyof QueueJobDataMap,
    options: EnsureQueueOptions = {},
  ): Promise<void> {
    await this.boss.createQueue(name, {
      retryLimit: options.retryLimit ?? this.config.retryLimit,
      retryBackoff: options.retryBackoff ?? true,
      expireInSeconds: options.expireInSeconds ?? this.config.expireInSeconds,
    });
  }

  async send<N extends keyof QueueJobDataMap>(
    name: N,
    data: QueueJobDataMap[N],
    options: SendJobOptions = {},
  ): Promise<string | null> {
    const { db, ...jobOptions } = options;

    return await this.boss.send(name, data, {
      retryLimit: jobOptions.retryLimit ?? this.config.retryLimit,
      retryBackoff: jobOptions.retryBackoff ?? true,
      expireInSeconds:
        jobOptions.expireInSeconds ?? this.config.expireInSeconds,
      ...(jobOptions.singletonKey && { singletonKey: jobOptions.singletonKey }),
      ...(db && { db }),
    });
  }

  async schedule(
    name: keyof QueueJobDataMap,
    cron: string,
    data: object | null = null,
  ): Promise<void> {
    await this.boss.schedule(name, cron, data);
  }

  /**
   * Registers a handler. Only the worker process calls this.
   *
   * `includeMetadata` is always on: the handlers need `retryCount`/`retryLimit`
   * to tell a retryable blip from the final attempt.
   */
  async work<N extends keyof QueueJobDataMap>(
    name: N,
    options: { batchSize?: number },
    handler: (jobs: WorkJob<QueueJobDataMap[N]>[]) => Promise<void>,
  ): Promise<string> {
    // No explicit type argument: pg-boss's `work` overload only narrows the
    // handler to the with-metadata variant when it can infer its `const O`
    // from this literal, and supplying any type argument makes TypeScript use
    // the defaults for the rest instead of inferring.
    return await this.boss.work(
      name,
      { batchSize: options.batchSize, includeMetadata: true },
      handler,
    );
  }

  async findJobs<N extends keyof QueueJobDataMap>(
    name: N,
    options: { data?: object; queued?: boolean; db?: Db } = {},
  ): Promise<{ id: string; data: QueueJobDataMap[N] }[]> {
    return await this.boss.findJobs<QueueJobDataMap[N]>(name, options);
  }

  async getSchedules(): Promise<{ name: string; cron: string }[]> {
    return await this.boss.getSchedules();
  }
}
