import { ApiProperty } from '@nestjs/swagger';
import { VideoFailureReason } from '../video-failure-reason.enum';
import { VideoStatus } from '../video-status.enum';

/**
 * The public representation of a video.
 *
 * `id`, `channel_id`, `upload_id` and `storage_key` are deliberately absent —
 * nothing internal leaves through this shape.
 */
export class VideoResponseDto {
  @ApiProperty({ description: 'Opaque 11-character public identifier.' })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true, type: String })
  description: string | null;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({
    enum: VideoFailureReason,
    enumName: 'VideoFailureReason',
    nullable: true,
    description: 'Set only when `status` is `failed`.',
  })
  failure_reason: VideoFailureReason | null;

  @ApiProperty({ nullable: true, type: Number })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true, type: Number })
  width: number | null;

  @ApiProperty({ nullable: true, type: Number })
  height: number | null;

  @ApiProperty()
  original_filename: string;

  @ApiProperty({ nullable: true, type: Number })
  size_bytes: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Presigned GET. Null until processing produces a thumbnail.',
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}
