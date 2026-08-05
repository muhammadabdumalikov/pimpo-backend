import {ApiProperty} from '@nestjs/swagger';
import {IsBoolean} from 'class-validator';

export class UpdatePayrollSettingsDto {
  @ApiProperty({
    description:
      "Post the previous month's accrual automatically on the 1st, so an " +
      'owner who never opens the page still gets a truthful balance.',
    example: true,
  })
  @IsBoolean()
  autoAccrue: boolean;
}
