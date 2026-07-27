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
} from 'class-validator';

export class UpdateStaffDto {
  @ApiProperty({ description: 'Employee display name', required: false })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ApiProperty({
    description:
      'Grant (true) or revoke (false) the system account. Revoking clears the ' +
      'credentials and frees the plan seat; the employee stays on payroll.',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  hasAccount?: boolean;

  @ApiProperty({ description: 'Login username (globally unique)', required: false })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  @IsOptional()
  login?: string;

  @ApiProperty({ description: 'Assigned dashboard role id', required: false })
  @IsString()
  @MinLength(1)
  @IsOptional()
  roleId?: string;

  @ApiProperty({ description: 'New password (resets it)', required: false })
  @IsString()
  @MinLength(6)
  @IsOptional()
  password?: string;

  @ApiProperty({ description: 'Job title (display only)', required: false })
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
    enum: ['none', 'fixed', 'percent', 'mixed'],
    description: 'Payroll shape',
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
    enum: ['revenue', 'profit'],
    description: 'What the percent applies to',
    required: false,
  })
  @IsIn(['revenue', 'profit'])
  @IsOptional()
  percentBase?: 'revenue' | 'profit';

  @ApiProperty({
    description: 'Whether the employee is active',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
