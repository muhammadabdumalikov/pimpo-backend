import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUnitDto {
  @ApiProperty({ description: 'Unit name', example: 'Kilogramm' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Short label shown next to quantities', example: 'kg' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  shortName: string;

  @ApiProperty({
    description:
      'Fraction digits allowed for quantities in this unit (0 = whole pieces)',
    example: 3,
    enum: [0, 1, 2, 3],
  })
  @IsInt()
  @IsIn([0, 1, 2, 3])
  precision: number;
}
