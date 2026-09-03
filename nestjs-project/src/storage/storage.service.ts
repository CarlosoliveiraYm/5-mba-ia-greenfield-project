import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export interface PresignedUrlOptions {
  /** Overrides `storage.presignedUrlExpirationSeconds`. */
  expiresIn?: number;
  /**
   * When present, storage answers with
   * `Content-Disposition: attachment; filename="..."` — which is what turns the
   * same presigned GET used for streaming into a download.
   */
  downloadFilename?: string;
  /** Range header to read only part of the object. */
  range?: string;
}

export interface HeadObjectResult {
  contentLength: number;
  contentType?: string;
  etag?: string;
}

/**
 * The single door to object storage for both the API and the worker.
 *
 * It holds *two* clients. `client` talks to the internal endpoint and does all
 * the real reading and writing. `presignClient` exists only to sign delivery
 * URLs against the browser-reachable endpoint: SigV4 signs the Host header, so a
 * URL signed for `minio:9000` is rejected when the browser fetches it from
 * `localhost:9000`.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly presignClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = this.createClient(config.endpoint);
    this.presignClient = this.createClient(config.publicEndpoint);
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  get bucket(): string {
    return this.config.bucket;
  }

  /**
   * `contentLength` is required for a stream body: without it the SDK falls back
   * to `aws-chunked` transfer encoding, which MinIO rejects on a plain PUT.
   */
  async putObject(
    key: string,
    body: Buffer | Readable | string,
    contentType?: string,
    contentLength?: number,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
    );
  }

  async getObjectStream(key: string, range?: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: range,
      }),
    );

    return response.Body as Readable;
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
      etag: response.ETag,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.config.bucket,
        CopySource: `${this.config.bucket}/${sourceKey}`,
        Key: destinationKey,
      }),
    );
  }

  /** A presigned GET the **browser** can fetch. */
  getPresignedUrl(key: string, options: PresignedUrlOptions = {}) {
    return this.presign(this.presignClient, key, options);
  }

  /**
   * A presigned GET signed for the *internal* endpoint, for server-side
   * consumers inside the Docker network (the worker's ffprobe). A URL signed for
   * `S3_PUBLIC_ENDPOINT` carries `localhost:9000` in its signed Host, which from
   * inside a container resolves to that container itself, not to MinIO.
   */
  getInternalPresignedUrl(key: string, options: PresignedUrlOptions = {}) {
    return this.presign(this.client, key, options);
  }

  private presign(
    client: S3Client,
    key: string,
    options: PresignedUrlOptions,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ...(options.downloadFilename && {
        ResponseContentDisposition: `attachment; filename="${sanitizeDownloadFilename(
          options.downloadFilename,
        )}"`,
      }),
    });

    return getSignedUrl(client, command, {
      expiresIn: options.expiresIn ?? this.config.presignedUrlExpirationSeconds,
    });
  }
}

/**
 * Keeps a hostile filename from breaking out of the quoted `filename="..."`
 * parameter — quotes, backslashes, control characters and path separators go.
 */
export function sanitizeDownloadFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/["\\\r\n\t\x00-\x1f]/g, '_').trim();

  return cleaned.length > 0 ? cleaned : 'download';
}
