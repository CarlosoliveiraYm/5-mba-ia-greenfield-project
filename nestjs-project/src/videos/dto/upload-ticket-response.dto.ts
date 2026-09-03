import { ApiProperty } from '@nestjs/swagger';

export class UploadTicketResponseDto {
  @ApiProperty({
    description:
      'Upload-scoped JWT. Presented in the Authorization header of every tus request.',
  })
  ticket: string;

  @ApiProperty({
    description: 'Browser-reachable tus endpoint.',
    example: 'http://localhost:3000/uploads',
  })
  upload_url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}
