import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { TUS_SERVER, TUS_STORE } from '../uploads/uploads.constants';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let context: INestApplicationContext;

  beforeAll(async () => {
    // Through the real standalone factory, not Test.createTestingModule — the
    // claim under test is that this module boots with no HTTP adapter at all.
    context = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['error'],
    });
  }, 120000);

  afterAll(async () => {
    await context.close();
  });

  it('should resolve every collaborator the worker needs', () => {
    expect(context.get(StorageService)).toBeInstanceOf(StorageService);
    expect(context.get(QueueService)).toBeInstanceOf(QueueService);
    expect(context.get(FfmpegService)).toBeInstanceOf(FfmpegService);
  });

  it('should provide a Video repository', () => {
    const repository = context.get<Repository<Video>>(
      getRepositoryToken(Video),
    );

    expect(typeof repository.findOne).toBe('function');
  });

  it('should import the tus store without the tus HTTP server', () => {
    const store = context.get<{ deleteExpired: unknown }>(TUS_STORE);
    expect(typeof store.deleteExpired).toBe('function');

    // The boundary that keeps the worker HTTP-free.
    expect(() => {
      context.get(TUS_SERVER);
    }).toThrow();
  });

  it('should register no controller in the standalone context', () => {
    // A standalone context has no HTTP adapter, so asking for the server is an
    // error rather than a route table.
    expect(() => {
      (
        context as unknown as { getHttpAdapter: () => unknown }
      ).getHttpAdapter();
    }).toThrow();
  });
});
