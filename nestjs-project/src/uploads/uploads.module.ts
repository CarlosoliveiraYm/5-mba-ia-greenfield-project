import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { VideosModule } from '../videos/videos.module';
import { Channel } from '../channels/entities/channel.entity';
import { TusStoreModule } from './tus-store.module';
import { tusServerProvider } from './tus-server.provider';
import { TUS_SERVER } from './uploads.constants';
import { UploadsService } from './uploads.service';

@Module({
  imports: [
    ConfigModule,
    TusStoreModule,
    StorageModule,
    QueueModule.register(),
    TypeOrmModule.forFeature([Video, Channel]),
    VideosModule,
  ],
  providers: [UploadsService, tusServerProvider],
  exports: [TUS_SERVER, UploadsService],
})
export class UploadsModule {}
