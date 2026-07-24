import {ApiProperty} from '@nestjs/swagger';
import {IsString, IsNotEmpty} from 'class-validator';

export class VerifyBillzDto {
  @ApiProperty({
    description:
      'BiLLZ integration secret key (Settings → Company → Integration keys)',
    example: 'blz_secret_XXXXXXXXXXXXXXXXXXXX',
  })
  @IsString()
  @IsNotEmpty()
  secretToken: string;
}
