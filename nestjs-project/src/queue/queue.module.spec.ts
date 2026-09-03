import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { QueueService } from './queue.service';
import { PG_BOSS, type PgBossInstance } from './queue.types';

// Two unrelated feature modules that both need to publish jobs — the shape the
// API really has (VideosModule and UploadsModule).
@Module({ imports: [QueueModule.register()], exports: [QueueModule] })
class FirstPublisherModule {}

@Module({ imports: [QueueModule.register()], exports: [QueueModule] })
class SecondPublisherModule {}

describe('QueueModule', () => {
  const compile = (imports: (Type | DynamicModule)[]) =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig],
        }),
        ...imports,
      ],
    }).compile();

  it('should compile and resolve PG_BOSS through the native-import factory', async () => {
    const module = await compile([QueueModule.register()]);

    const boss = module.get<PgBossInstance>(PG_BOSS);
    expect(typeof boss.send).toBe('function');
    expect(typeof boss.createQueue).toBe('function');

    await module.close();
  }, 30000);

  it('should export QueueService', async () => {
    const module = await compile([QueueModule.register()]);

    expect(module.get(QueueService)).toBeInstanceOf(QueueService);

    await module.close();
  }, 30000);

  it('should share one PgBoss across every module that registers it send-only', async () => {
    const module = await compile([FirstPublisherModule, SecondPublisherModule]);

    // Strict lookups: each module's own injector, not a fallback to the root.
    const fromFirst = module
      .select(FirstPublisherModule)
      .get<PgBossInstance>(PG_BOSS);
    const fromSecond = module
      .select(SecondPublisherModule)
      .get<PgBossInstance>(PG_BOSS);

    // Two instances would mean two connection pools and two sets of timers.
    expect(fromFirst).toBe(fromSecond);

    await module.close();
  }, 30000);

  it('should share one QueueService too, so a stub applied to it is seen everywhere', async () => {
    const module = await compile([FirstPublisherModule, SecondPublisherModule]);

    const fromFirst = module
      .select(FirstPublisherModule)
      .get<QueueService>(QueueService);
    const fromSecond = module
      .select(SecondPublisherModule)
      .get<QueueService>(QueueService);

    expect(fromFirst).toBe(fromSecond);

    await module.close();
  }, 30000);
});
