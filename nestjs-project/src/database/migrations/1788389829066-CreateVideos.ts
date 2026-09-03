import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1788389829066 implements MigrationInterface {
  name = 'CreateVideos1788389829066';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."video_status" AS ENUM('draft', 'uploading', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(16) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(100) NOT NULL, "description" text, "status" "public"."video_status" NOT NULL DEFAULT 'draft', "failure_reason" character varying(64), "upload_id" character varying(255), "original_filename" character varying(255) NOT NULL, "storage_key" character varying(512), "thumbnail_key" character varying(512), "mime_type" character varying(100), "size_bytes" bigint, "duration_seconds" numeric(10,3), "width" integer, "height" integer, "video_codec" character varying(32), "audio_codec" character varying(32), "container" character varying(32), "upload_expires_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "UQ_0673e1f1b124b650683fc061c94" UNIQUE ("upload_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5ac8800b0276a123ab82d906ec" ON "videos" ("status", "upload_expires_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5ac8800b0276a123ab82d906ec"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."video_status"`);
  }
}
