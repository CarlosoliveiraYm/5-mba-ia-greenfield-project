import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import mailConfig from '../config/mail.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import swaggerConfig from '../config/swagger.config';
import uploadConfig from '../config/upload.config';
import { ChannelsModule } from '../channels/channels.module';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { TusStoreModule } from '../uploads/tus-store.module';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';
import { UploadSweepHandler } from './upload-sweep.handler';
import { VideoProcessingHandler } from './video-processing.handler';

/**
 * The worker's composition root.
 *
 * It deliberately imports neither `AppModule`, nor `AuthModule`, nor any
 * controller — that boundary is what keeps the worker HTTP-free, so FFmpeg's CPU
 * pressure never competes with the API's event loop.
 *
 * `TusStoreModule` is imported for the store alone (the sweep needs
 * `deleteExpired`), never `UploadsModule`, which carries the tus HTTP server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        queueConfig,
        storageConfig,
        swaggerConfig,
        uploadConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    // `Video.channel` is a relation, so TypeORM needs Channel's metadata (and,
    // through it, User's) registered even though the worker never queries them
    // directly. Imported from their owning modules rather than re-declared
    // here; neither carries a controller, so the worker stays HTTP-free.
    ChannelsModule,
    UsersModule,
    StorageModule,
    // The only place that supervises jobs and runs the cron scheduler; the API
    // side is send-only.
    QueueModule.register({ supervise: true, schedule: true }),
    FfmpegModule,
    TusStoreModule,
  ],
  providers: [VideoProcessingHandler, UploadSweepHandler],
  exports: [VideoProcessingHandler, UploadSweepHandler],
})
export class WorkerModule {}
