import { registerAs } from '@nestjs/config';

/**
 * There is deliberately no `QUEUE_SUPERVISE` key: the API and the worker read
 * the same `.env`, so one env value cannot express "API send-only, worker
 * supervises". That flag is passed in code, per process, by each entrypoint's
 * `QueueModule.register()` call.
 */
export default registerAs('queue', () => ({
  schema: process.env.QUEUE_SCHEMA || 'pgboss',
  retryLimit: parseInt(process.env.QUEUE_RETRY_LIMIT || '3', 10),
  expireInSeconds: parseInt(process.env.QUEUE_EXPIRE_IN_SECONDS || '3600', 10),
  /** Scratch space for the worker's remux working files. */
  workerScratchDir: process.env.WORKER_SCRATCH_DIR || '/tmp/streamtube',
  /** How many `video.process` jobs one worker fetches at a time. */
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '1', 10),
  /** How often the abandoned-upload sweep runs. Hourly by default. */
  uploadSweepCron: process.env.UPLOAD_SWEEP_CRON || '0 * * * *',
}));
