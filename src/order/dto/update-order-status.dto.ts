import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsIn } from 'class-validator';

export class UpdateOrderStatusDto {
  @ApiProperty({
    description: 'New order status',
    enum: ['Pending', 'Completed', 'Cancelled'],
  })
  @IsString()
  @IsIn(['Pending', 'Completed', 'Cancelled'])
  status: string;
}
