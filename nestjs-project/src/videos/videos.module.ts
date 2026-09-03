import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import authConfig from '../config/auth.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { UploadTicketService } from './upload-ticket.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule.register(),
    // Registered here rather than imported from AuthModule: importing that
    // module would re-register its APP_GUARD providers. The signing secret is
    // the access-token one on purpose — an upload ticket is the same trust
    // domain, distinguished by its `scope` claim, not by a separate key.
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (cfg: ConfigType<typeof authConfig>) => ({
        secret: cfg.jwtSecret,
      }),
    }),
  ],
  controllers: [VideosController],
  providers: [VideosService, UploadTicketService],
  exports: [VideosService, UploadTicketService, TypeOrmModule],
})
export class VideosModule {}
