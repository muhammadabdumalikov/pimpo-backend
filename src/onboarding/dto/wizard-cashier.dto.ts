import {ApiProperty} from '@nestjs/swagger';
import {Transform} from 'class-transformer';
import {IsString, MaxLength, MinLength} from 'class-validator';

// Surrounding spaces from a phone keyboard would make a blank name pass and a
// login nobody can type back in.
const trim = ({value}: {value: unknown}) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * POST /onboarding/wizard/cashier — the seller's sign-in. The same limits as
 * POST /staff; the role, branch and position are filled in by the server.
 */
export class CreateWizardCashierDto {
  @ApiProperty({description: "Seller's name", example: 'Ali Valiyev'})
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiProperty({description: 'Login (unique across KPOS)', example: 'ali_kassir'})
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  login: string;

  @ApiProperty({description: 'Password, at least 6 characters'})
  @IsString()
  @MinLength(6)
  password: string;
}
