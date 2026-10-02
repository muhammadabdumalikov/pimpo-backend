import {ApiProperty} from '@nestjs/swagger';
import {IsString, Matches, MinLength} from 'class-validator';
import {PIN_PATTERN} from '../../utils/pin';

export class DeviceSessionDto {
  @ApiProperty({description: 'Employee signing in on this till'})
  @IsString()
  @MinLength(1)
  staffId: string;

  @ApiProperty({description: 'Till PIN, 4–6 digits', example: '4821'})
  @IsString()
  @Matches(PIN_PATTERN)
  pin: string;
}
