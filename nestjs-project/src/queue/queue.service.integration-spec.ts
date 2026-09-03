import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { QueueModule } from './queue.module';
import { QueueService } from './queue.service';
import { QUEUE_NAMES, toPgBossDb } from './queue.types';

describe('QueueService (integration)', () => {
  let module: TestingModule;
  let queueService: QueueService;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig],
        }),
        QueueModule.register(),
      ],
    }).compile();

    queueService = module.get(QueueService);
    dataSource = createTestDataSource([]);
    await dataSource.initialize();

    await queueService.ensureQueue(QUEUE_NAMES.VIDEO_PROCESS);
  }, 60000);

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  describe('ensureQueue', () => {
    it('should be idempotent for the same queue name', async () => {
      await expect(
        queueService.ensureQueue(QUEUE_NAMES.VIDEO_PROCESS),
      ).resolves.toBeUndefined();
      await expect(
        queueService.ensureQueue(QUEUE_NAMES.VIDEO_PROCESS),
      ).resolves.toBeUndefined();
    });
  });

  describe('send', () => {
    it('should persist a job that findJobs can read back', async () => {
      const videoId = randomUUID();

      const jobId = await queueService.send(QUEUE_NAMES.VIDEO_PROCESS, {
        videoId,
      });

      expect(jobId).toEqual(expect.any(String));
      const jobs = await queueService.findJobs(QUEUE_NAMES.VIDEO_PROCESS, {
        data: { videoId },
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({ videoId });
    });
  });

  describe('toPgBossDb', () => {
    it('should wrap TypeORM row arrays into the { rows } shape pg-boss expects', async () => {
      await dataSource.transaction(async (manager) => {
        const db = toPgBossDb(manager);

        const result = await db.executeSql('SELECT $1::int AS answer', [42]);

        // manager.query() resolves to the array itself; pg-boss reads `.rows`.
        expect(result).toEqual({ rows: [{ answer: 42 }] });
      });
    });
  });

  describe('transactional enqueue', () => {
    const countJobs = async (videoId: string) =>
      (
        await queueService.findJobs(QUEUE_NAMES.VIDEO_PROCESS, {
          data: { videoId },
        })
      ).length;

    it('should leave no job behind when the surrounding transaction rolls back', async () => {
      const videoId = randomUUID();

      await expect(
        dataSource.transaction(async (manager) => {
          await queueService.send(
            QUEUE_NAMES.VIDEO_PROCESS,
            { videoId },
            { db: toPgBossDb(manager) },
          );
          throw new Error('rolling this back on purpose');
        }),
      ).rejects.toThrow('rolling this back on purpose');

      expect(await countJobs(videoId)).toBe(0);
    });

    it('should keep the job when the surrounding transaction commits', async () => {
      const videoId = randomUUID();

      await dataSource.transaction(async (manager) => {
        await queueService.send(
          QUEUE_NAMES.VIDEO_PROCESS,
          { videoId },
          { db: toPgBossDb(manager) },
        );
      });

      expect(await countJobs(videoId)).toBe(1);
    });
  });
});
