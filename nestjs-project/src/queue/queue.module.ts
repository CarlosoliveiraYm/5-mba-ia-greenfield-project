import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { nativeImport } from '../common/native-import';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { QueueService } from './queue.service';
import { PG_BOSS, type PgBossInstance } from './queue.types';

export interface QueueModuleOptions {
  /**
   * Run pg-boss's job supervision (retries, expiry, archiving). Only the worker
   * process does — the API is send-only.
   */
  supervise?: boolean;
  /** Run the cron scheduler. Worker only, for the same reason. */
  schedule?: boolean;
}

const SEND_ONLY: Required<QueueModuleOptions> = {
  supervise: false,
  schedule: false,
};

/**
 * One started `PgBoss` per role per process.
 *
 * Nest builds a separate module instance for each `QueueModule.register()` call
 * site, so several feature modules importing the queue would otherwise each get
 * their own boss — and their own connection pool and background timers. The
 * boss is a process-level resource, so it is cached here rather than left to the
 * DI container's module identity.
 */
const bossByRole = new Map<string, Promise<PgBossInstance>>();

async function startBoss(
  role: string,
  options: Required<QueueModuleOptions>,
  dbConfig: ConfigType<typeof databaseConfig>,
  queueCfg: ConfigType<typeof queueConfig>,
): Promise<PgBossInstance> {
  // pg-boss@12 is pure ESM; see `native-import.ts` for why this is not a plain
  // dynamic import. Note the *named* export: v12 has no default export.
  const { PgBoss } = await nativeImport<typeof import('pg-boss')>('pg-boss');

  const boss = new PgBoss({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    schema: queueCfg.schema,
    supervise: options.supervise,
    schedule: options.schedule,
  });

  boss.on('error', () => {
    // pg-boss is an EventEmitter: an unhandled 'error' event would take the
    // whole process down. Transient pool errors are recoverable, and every
    // command still rejects on its own, so they are swallowed here.
  });

  // Safe from both processes: pg-boss guards its own migrations with a
  // Postgres advisory lock.
  await boss.start();

  return boss;
}

function resolveBoss(
  role: string,
  options: Required<QueueModuleOptions>,
  dbConfig: ConfigType<typeof databaseConfig>,
  queueCfg: ConfigType<typeof queueConfig>,
): Promise<PgBossInstance> {
  const cached = bossByRole.get(role);
  if (cached) {
    return cached;
  }

  const starting = startBoss(role, options, dbConfig, queueCfg);
  bossByRole.set(role, starting);

  return starting;
}

/**
 * The `QueueService` is shared for the same reason as the boss: one instance per
 * role per process. Without this, two modules importing the queue hold two
 * services over one boss — functionally equivalent, but a spy or a stub applied
 * to one silently does not apply to the other.
 */
const serviceByRole = new Map<string, QueueService>();

/** Called when the boss is stopped, so a later bootstrap starts a fresh one. */
export function forgetBoss(boss: unknown): void {
  for (const [role, pending] of bossByRole) {
    void pending.then((candidate) => {
      if (candidate === boss) {
        bossByRole.delete(role);
        serviceByRole.delete(role);
      }
    });
  }
}

const createPgBossProvider = (
  role: string,
  options: Required<QueueModuleOptions>,
): Provider => ({
  provide: PG_BOSS,
  inject: [databaseConfig.KEY, queueConfig.KEY],
  useFactory: (
    dbConfig: ConfigType<typeof databaseConfig>,
    queueCfg: ConfigType<typeof queueConfig>,
  ) => resolveBoss(role, options, dbConfig, queueCfg),
});

const createQueueServiceProvider = (role: string): Provider => ({
  provide: QueueService,
  inject: [PG_BOSS, queueConfig.KEY],
  useFactory: (
    boss: PgBossInstance,
    queueCfg: ConfigType<typeof queueConfig>,
  ) => {
    const cached = serviceByRole.get(role);
    if (cached) {
      return cached;
    }

    const created = new QueueService(boss, queueCfg);
    serviceByRole.set(role, created);

    return created;
  },
});

@Module({})
export class QueueModule {
  /**
   * Defaults to send-only. The worker's entrypoint is the single caller that
   * passes `{ supervise: true, schedule: true }`.
   */
  static register(options: QueueModuleOptions = {}): DynamicModule {
    const resolved: Required<QueueModuleOptions> = { ...SEND_ONLY, ...options };
    const role = `supervise=${resolved.supervise},schedule=${resolved.schedule}`;

    return {
      module: QueueModule,
      imports: [ConfigModule],
      providers: [
        createPgBossProvider(role, resolved),
        createQueueServiceProvider(role),
      ],
      exports: [PG_BOSS, QueueService],
    };
  }
}
