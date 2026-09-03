import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { generatePublicId } from '../public-id.util';
import { VideoFailureReason } from '../video-failure-reason.enum';
import { VideoStatus } from '../video-status.enum';

@Entity('videos')
// Drives the hourly abandoned-upload sweep, which scans by status + deadline.
@Index(['status', 'upload_expires_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The only identifier that appears in a URL. */
  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  /** Derived from the uploaded filename at draft creation; editable later. */
  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  /** Set only alongside `status = 'failed'`. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  failure_reason: VideoFailureReason | null;

  /** tus upload identifier — the join key from a tus request back to its video. */
  @Column({ type: 'varchar', length: 255, unique: true, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  /**
   * The tus upload id, which **is** the S3 object key. The faststart remux is
   * promoted onto it, so a video only ever has one key.
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** Declared by the client at create, corrected by ffprobe. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  mime_type: string | null;

  /** The driver returns `bigint` as a string; callers convert at the boundary. */
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  video_codec: string | null;

  /** Null when the source carries no audio stream. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  audio_codec: string | null;

  /** ffprobe's `format_name`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  container: string | null;

  /** `now + UPLOAD_ABANDONED_EXPIRATION_HOURS` at draft creation. */
  @Column({ type: 'timestamp', nullable: true })
  upload_expires_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @BeforeInsert()
  assignPublicId(): void {
    if (!this.public_id) {
      this.public_id = generatePublicId();
    }
  }
}
