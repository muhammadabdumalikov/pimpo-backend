import {ApiProperty} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import {CreateOrderDto} from './create-order.dto';

// Bulk order creation for offline sync: the POS flushes its whole outbox in one
// request when connectivity returns. Each order carries its own clientId, so the
// service processes them independently and idempotently (one bad sale can't
// block the rest). See OFFLINE.md.
export class BatchCreateOrderDto {
  @ApiProperty({
    description: 'Queued offline orders to create',
    type: [CreateOrderDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({each: true})
  @Type(() => CreateOrderDto)
  orders: CreateOrderDto[];
}
