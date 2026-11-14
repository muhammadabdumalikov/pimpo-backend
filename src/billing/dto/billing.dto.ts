import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  NotEquals,
  ValidateIf,
} from 'class-validator';

/** Self-serve plan change (PUT /subscriptions/current, POST /subscriptions/subscribe). */
export class ChangePlanDto {
  @ApiProperty({
    description: 'Plan tier, e.g. basic | pro | proplus | food',
    example: 'pro',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  tier: string;
}

/** "To'lov qildim" — the shop says it paid by card/transfer. */
export class CreatePaymentRequestDto {
  @ApiProperty({description: 'Amount paid (UZS)', example: 299000})
  @IsNumber({maxDecimalPlaces: 2})
  @IsPositive()
  @Max(10_000_000_000)
  amount: number;

  @ApiPropertyOptional({
    description: 'Free text for the reviewer',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  comment?: string;
}

/** Platform: approve a payment request — credits the balance. */
export class ApprovePaymentRequestDto {
  @ApiPropertyOptional({
    description: 'Amount actually received; defaults to the requested amount',
  })
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 2})
  @IsPositive()
  @Max(10_000_000_000)
  amount?: number;

  @ApiPropertyOptional({description: 'Internal note for the ledger'})
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Platform: reject a payment request. The reason is shown to the shop. */
export class RejectPaymentRequestDto {
  @ApiProperty({
    description: 'Why the payment was not accepted (shown to the shop)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** Platform: signed balance correction. Never takes the balance below zero. */
export class AdjustBalanceDto {
  @ApiProperty({description: 'Signed amount (UZS), not zero', example: -50000})
  @IsNumber({maxDecimalPlaces: 2})
  @NotEquals(0)
  @Min(-10_000_000_000)
  @Max(10_000_000_000)
  amount: number;

  @ApiProperty({description: 'Internal note: why the balance was corrected'})
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  note: string;
}

/** Platform: where shops send money. Every field optional; null clears it. */
export class PaymentRequisitesDto {
  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  cardNumber?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(255)
  cardHolder?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(255)
  bankName?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  accountNumber?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(16)
  mfo?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(255)
  recipientName?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  inn?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export const PAYMENT_REQUEST_FILTERS = ['pending', 'resolved', 'all'] as const;
export type PaymentRequestFilter = (typeof PAYMENT_REQUEST_FILTERS)[number];

/** POST /subscriptions/ai-addon — the AI bot add-on on/off (ONLAYN-SOTUVCHI.md E6). */
export class SetAiAddonDto {
  @ApiProperty({
    description:
      'true charges the rest of the period and keeps it for the next; ' +
      'false only stops the next renewal from billing it',
  })
  @IsBoolean()
  enabled: boolean;
}

/** POST /subscriptions/billing-cycle — monthly or yearly from the next renewal (OBUNA-TOLOV.md §9). */
export class SetBillingCycleDto {
  @ApiProperty({enum: ['month', 'year']})
  @IsIn(['month', 'year'])
  cycle: 'month' | 'year';
}
