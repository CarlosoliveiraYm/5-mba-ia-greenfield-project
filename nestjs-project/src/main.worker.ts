import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import queueConfig from './config/queue.config';
import { QueueService } from './queue/queue.service';
import { QUEUE_NAMES } from './queue/queue.types';
import { UploadSweepHandler } from './worker/upload-sweep.handler';
import { VideoProcessingHandler } from './worker/video-processing.handler';
import { WorkerModule } from './worker/worker.module';
import type { ConfigType } from '@nestjs/config';

/**
 * The video worker: a standalone Nest application context, with no HTTP
 * listener at all. It shares the codebase, the dependency manifest and the test
 * suite with the API, and nothing else.
 */
async function bootstrap() {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  const queueService = app.get(QueueService);
  const queueCfg = app.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  const videoProcessing = app.get(VideoProcessingHandler);
  const uploadSweep = app.get(UploadSweepHandler);

  await queueService.ensureQueue(QUEUE_NAMES.VIDEO_PROCESS);
  await queueService.work(
    QUEUE_NAMES.VIDEO_PROCESS,
    { batchSize: queueCfg.workerConcurrency },
    async (jobs) => {
      for (const job of jobs) {
        await videoProcessing.process(job.data, {
          attempt: job.retryCount,
          maxAttempts: job.retryLimit,
        });
      }
    },
  );
  logger.log(
    `Handling "${QUEUE_NAMES.VIDEO_PROCESS}" with batchSize ${queueCfg.workerConcurrency}`,
  );

  // A missed sweep is covered by the next tick, so one retry and no backoff.
  await queueService.ensureQueue(QUEUE_NAMES.UPLOAD_SWEEP, {
    retryLimit: 1,
    retryBackoff: false,
  });
  await queueService.work(
    QUEUE_NAMES.UPLOAD_SWEEP,
    { batchSize: 1 },
    async () => {
      await uploadSweep.process();
    },
  );
  await queueService.schedule(
    QUEUE_NAMES.UPLOAD_SWEEP,
    queueCfg.uploadSweepCron,
  );
  logger.log(`Sweep scheduled: "${queueCfg.uploadSweepCron}"`);

  // On SIGTERM/SIGINT Nest runs the shutdown hooks, which stop pg-boss — jobs in
  // flight finish or are returned to the queue rather than being lost.
  const shutdown = (signal: string) => {
    logger.log(`Received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.log('Video worker started — no HTTP listener bound');
}

void bootstrap();
