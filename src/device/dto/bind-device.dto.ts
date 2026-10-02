import {ApiProperty} from '@nestjs/swagger';
import {IsString, MaxLength, MinLength} from 'class-validator';

export class BindDeviceDto {
  @ApiProperty({description: 'Register (kassa) this PC sells on'})
  @IsString()
  @MinLength(1)
  registerId: string;

  @ApiProperty({
    description: 'Device name, e.g. the PC hostname',
    example: 'KASSA-1',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;
}
