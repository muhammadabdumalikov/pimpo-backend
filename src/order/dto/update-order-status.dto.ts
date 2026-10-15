import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsIn } from 'class-validator';

export class UpdateOrderStatusDto {
  @ApiProperty({
    description: 'New order status',
    enum: ['Pending', 'Confirmed', 'Assembling', 'Completed', 'Cancelled'],
  })
  @IsString()
  @IsIn(['Pending', 'Confirmed', 'Assembling', 'Completed', 'Cancelled'])
  status: string;
}
