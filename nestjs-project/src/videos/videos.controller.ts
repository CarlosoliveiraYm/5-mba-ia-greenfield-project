import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import {
  DownloadUrlResponseDto,
  SignedUrlResponseDto,
} from './dto/signed-url-response.dto';
import { UploadTicketResponseDto } from './dto/upload-ticket-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload-ticket')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue an upload ticket',
    description:
      'Mints the short-lived, upload-scoped token the browser presents to the ' +
      'tus endpoint, and returns the endpoint to send it to. Only one upload ' +
      'may be in flight per user at a time.',
  })
  @ApiOkResponse({ type: UploadTicketResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Access token missing or invalid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiConflictResponse({
    description: 'UPLOAD_ALREADY_IN_PROGRESS — an upload is already in flight',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  requestUploadTicket(
    @CurrentUser() user: JwtPayload,
  ): Promise<UploadTicketResponseDto> {
    return this.videosService.requestUploadTicket(user.sub);
  }

  /**
   * The polling contract. `@SkipThrottle()` applies to this route **only**:
   * Phase 02's `ThrottlerGuard` is an `APP_GUARD`, so it is global regardless of
   * the module that declares it, and its 10-requests-per-minute window would
   * trip a client polling every few seconds while a video is processing. Every
   * other `videos` route stays limited.
   */
  @SkipThrottle()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Read a video',
    description:
      'Returns the live processing status and metadata of a video the caller ' +
      'owns. Safe to poll: this endpoint is exempt from the global rate limit.',
  })
  @ApiParam({ name: 'publicId', description: 'Opaque public identifier.' })
  @ApiOkResponse({ type: VideoResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Access token missing or invalid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiNotFoundResponse({
    description:
      'VIDEO_NOT_FOUND — unknown id, or a video the caller does not own ' +
      '(indistinguishable on purpose)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findByPublicIdForOwner(
      publicId,
      user.sub,
    );

    return this.videosService.toResponseDto(video);
  }

  @Get(':publicId/playback')
  @ApiOperation({
    summary: 'Get a playback URL',
    description:
      'Returns a short-lived presigned URL the player streams from directly. ' +
      'The video bytes never transit this API; the URL serves HTTP Range, so ' +
      'playback starts without downloading the whole file.',
  })
  @ApiParam({ name: 'publicId', description: 'Opaque public identifier.' })
  @ApiOkResponse({ type: SignedUrlResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Access token missing or invalid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiNotFoundResponse({
    description: 'VIDEO_NOT_FOUND — unknown id, or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiConflictResponse({
    description: 'VIDEO_NOT_READY — the video has not finished processing',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getPlaybackUrl(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getPlaybackUrl(publicId, user.sub);
  }

  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'The same mechanism as playback, presigned with a Content-Disposition ' +
      'that makes the browser save the file under its original name.',
  })
  @ApiParam({ name: 'publicId', description: 'Opaque public identifier.' })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Access token missing or invalid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiNotFoundResponse({
    description: 'VIDEO_NOT_FOUND — unknown id, or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiConflictResponse({
    description: 'VIDEO_NOT_READY — the video has not finished processing',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getDownloadUrl(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<DownloadUrlResponseDto> {
    return this.videosService.getDownloadUrl(publicId, user.sub);
  }
}
