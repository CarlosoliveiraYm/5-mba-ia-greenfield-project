import { ApiProperty } from '@nestjs/swagger';

/**
 * These endpoints return a **URL**, never the bytes. Authorization is
 * re-evaluated on every issuance, but a URL that leaks stays valid until it
 * expires.
 */
export class SignedUrlResponseDto {
  @ApiProperty({
    description:
      'Presigned GET, valid for PRESIGNED_URL_EXPIRATION_SECONDS. Serves HTTP Range.',
  })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}

export class DownloadUrlResponseDto extends SignedUrlResponseDto {
  @ApiProperty({ description: 'The original uploaded filename.' })
  filename: string;
}
