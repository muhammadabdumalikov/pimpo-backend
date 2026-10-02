import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIn,
  IsNumber,
  IsDateString,
  Min,
  Max,
  MinLength,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import {PIN_PATTERN} from '../../utils/pin';

// An account holder signs in with a login+password, a till PIN, or both. The
// login pair is required unless a PIN is given; once a login is given its
// password is required too.
const needsLoginPair = (o: CreateStaffDto) =>
  o.hasAccount === true && (!o.pin || o.login !== undefined);

export class CreateStaffDto {
  @ApiProperty({ description: 'Employee display name', example: 'Ali Valiyev' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description:
      'Whether this employee gets a system account (POS + dashboard login). ' +
      'Only account holders consume a seat against the plan user limit.',
    default: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  hasAccount?: boolean;

  @ApiProperty({
    description:
      'Login username (globally unique). Required when hasAccount and no PIN.',
    example: 'ali_cashier',
    required: false,
  })
  @ValidateIf(needsLoginPair)
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  login?: string;

  @ApiProperty({
    description: 'Password. Required together with login.',
    required: false,
  })
  @ValidateIf(needsLoginPair)
  @IsString()
  @MinLength(6)
  password?: string;

  @ApiProperty({
    description: 'Assigned dashboard role id. Required when hasAccount.',
    required: false,
  })
  @ValidateIf((o: CreateStaffDto) => o.hasAccount === true)
  @IsString()
  @MinLength(1)
  roleId?: string;

  @ApiProperty({
    description:
      'Till PIN for the desktop app, 4–6 digits. Only an account holder gets one.',
    example: '4821',
    required: false,
  })
  @IsString()
  @Matches(PIN_PATTERN)
  @IsOptional()
  pin?: string;

  @ApiProperty({
    description: 'Job title (Sotuvchi, Omborchi…) — display only',
    required: false,
  })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  position?: string;

  @ApiProperty({ description: 'Contact phone', required: false })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Branch the employee works at', required: false })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiProperty({ description: 'Hire date (ISO)', required: false })
  @IsDateString()
  @IsOptional()
  hiredAt?: string;

  @ApiProperty({
    description:
      "Payroll shape: 'none' (off payroll), 'fixed' (oklad), " +
      "'percent' (% of own sales), 'mixed' (both)",
    enum: ['none', 'fixed', 'percent', 'mixed'],
    default: 'none',
    required: false,
  })
  @IsIn(['none', 'fixed', 'percent', 'mixed'])
  @IsOptional()
  salaryType?: 'none' | 'fixed' | 'percent' | 'mixed';

  @ApiProperty({ description: 'Fixed monthly wage, UZS', required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  baseSalary?: number;

  @ApiProperty({ description: 'Percent of own sales (0–100)', required: false })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  salesPercent?: number;

  @ApiProperty({
    description: 'What the percent applies to: revenue (tushum) or profit (foyda)',
    enum: ['revenue', 'profit'],
    default: 'revenue',
    required: false,
  })
  @IsIn(['revenue', 'profit'])
  @IsOptional()
  percentBase?: 'revenue' | 'profit';
}
