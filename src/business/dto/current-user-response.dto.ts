import { ApiProperty } from '@nestjs/swagger';
import { BusinessResponseDto } from './business-response.dto';
import { AccountDto } from './login-response.dto';

export class CurrentUserResponseDto {
  @ApiProperty({
    description: 'Owning business information',
    type: BusinessResponseDto,
  })
  business: BusinessResponseDto;

  @ApiProperty({
    description:
      'Acting account (owner or staff) with the allowed sidebar menu keys ' +
      'that drive the frontend permissions and menu visibility.',
    type: AccountDto,
  })
  account: AccountDto;
}
