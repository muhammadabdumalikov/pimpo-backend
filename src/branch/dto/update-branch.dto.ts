import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUrl, MaxLength, MinLength } from 'class-validator';

export class UpdateBranchDto {
  @ApiPropertyOptional({ description: 'Branch (do\'kon) name' })
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Address' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ description: 'Phone shown to customers', example: '+998 90 123 45 67' })
  @IsString()
  @IsOptional()
  @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({
    description:
      'Weekly hours: { mon: {open:"09:00", close:"21:00"} | null, … sun }; null clears',
  })
  @IsOptional()
  workingHours?: Record<string, { open: string; close: string } | null> | null;

  @ApiPropertyOptional({ description: 'Map link (Google / Yandex maps)' })
  @IsOptional()
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(500)
  mapUrl?: string | null;
}
