import {ApiProperty} from '@nestjs/swagger';
import {IsIn, IsNotEmpty, IsString} from 'class-validator';
import {PROBE_ENTITIES, type ProbeEntity} from '../billz-import.types';

// MG2 probe: preview ONE small page of raw BiLLZ JSON + how KPOS maps it. Only
// products/customers are probeable (images have no standalone list endpoint).
export class ProbeBillzDto {
  @ApiProperty({
    description: 'Which BiLLZ entity to preview.',
    enum: PROBE_ENTITIES as unknown as string[],
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(PROBE_ENTITIES as unknown as string[])
  entity: ProbeEntity;
}
