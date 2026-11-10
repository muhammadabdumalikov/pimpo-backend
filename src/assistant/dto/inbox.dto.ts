import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Transform} from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const toBool = ({value}: {value: unknown}) => value === true || value === 'true' || value === '1';

export class InboxListQueryDto {
  @ApiPropertyOptional({enum: ['all', 'bot', 'waiting', 'human', 'closed']})
  @IsOptional()
  @IsIn(['all', 'bot', 'waiting', 'human', 'closed'])
  status?: 'all' | 'bot' | 'waiting' | 'human' | 'closed';

  @ApiPropertyOptional({description: 'Name, @username or message text'})
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({description: 'Only chats assigned to me'})
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  mine?: boolean;

  @ApiPropertyOptional({description: 'Last message is from the customer'})
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  unanswered?: boolean;

  @ApiPropertyOptional({description: 'Cursor: nextBefore of the previous page'})
  @IsOptional()
  @IsISO8601()
  before?: string;
}

export class InboxMessagesQueryDto {
  @ApiPropertyOptional({description: 'Older page: createdAt of the oldest loaded message'})
  @IsOptional()
  @IsISO8601()
  before?: string;
}

export class InboxReplyDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text: string;
}

export class InboxBotDto {
  @ApiProperty({description: 'true = the bot stays out of this chat until resumed'})
  @IsBoolean()
  paused: boolean;
}

export class InboxAssignDto {
  @ApiProperty({nullable: true, description: 'Owner = business id, staff = staff id; null unassigns'})
  @ValidateIf((_, v) => v !== null)
  @IsString()
  assigneeId: string | null;
}

export class InboxCustomerDto {
  @ApiProperty({nullable: true})
  @ValidateIf((_, v) => v !== null)
  @IsString()
  customerId: string | null;
}

export class InboxNoteDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}

export class InboxFlagDto {
  @ApiProperty({nullable: true, enum: ['wrong']})
  @ValidateIf((_, v) => v !== null)
  @IsIn(['wrong'])
  flag: 'wrong' | null;
}

export class InboxFaqDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  question: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  answer: string;
}

export class QuickReplyDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}

export class UpdateQuickReplyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text?: string;
}
