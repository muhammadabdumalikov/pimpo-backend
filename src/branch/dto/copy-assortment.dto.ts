import {ApiProperty} from '@nestjs/swagger';
import {IsArray, IsBoolean, IsString, MaxLength} from 'class-validator';

export class CopyAssortmentDto {
  @ApiProperty({description: 'Branch whose assortment is copied'})
  @IsString()
  @MaxLength(36)
  fromBranchId: string;

  @ApiProperty({
    type: [String],
    description: "Category ids to include; 'none' = uncategorised cards",
  })
  @IsArray()
  @IsString({each: true})
  @MaxLength(100, {each: true})
  categoryIds: string[];

  @ApiProperty({
    description:
      'Only cards on hand or moved in the last 90 days at the source',
  })
  @IsBoolean()
  liveOnly: boolean;
}
