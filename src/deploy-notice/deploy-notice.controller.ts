import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  UseGuards,
} from '@nestjs/common';
import {ApiExcludeController} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {timingSafeEqual} from 'crypto';
import {Request} from 'express';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DeployNoticeService} from './deploy-notice.service';

const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\//;

class DeployCommitDto {
  @IsString()
  @Matches(/^[0-9a-f]{7,40}$/)
  sha: string;

  @IsString()
  @MaxLength(20_000)
  message: string;

  @IsString()
  @Matches(GITHUB_URL)
  url: string;
}

export class DeployNoticeDto {
  @IsString()
  @MaxLength(80)
  label: string;

  @IsArray()
  @ArrayMaxSize(250)
  @ValidateNested({each: true})
  @Type(() => DeployCommitDto)
  commits: DeployCommitDto[];

  @IsInt()
  @Min(0)
  total: number;

  @IsOptional()
  @IsString()
  @Matches(GITHUB_URL)
  compareUrl?: string;
}

/**
 * `X-Deploy-Token` must match DEPLOY_NOTICE_TOKEN. Its own token, not
 * ADMIN_API_TOKEN: it lives in GitHub secrets, and all it can do is post to
 * the deploy channel. Unset = refused.
 */
@Injectable()
class DeployTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = process.env.DEPLOY_NOTICE_TOKEN?.trim();
    const provided = req.headers['x-deploy-token'];
    const ok =
      !!expected &&
      typeof provided === 'string' &&
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) throw new AppException(ErrorCode.PLATFORM_ADMIN_REQUIRED);
    return true;
  }
}

/** The dashboard's GitHub Actions deploy reports what it shipped here. */
@ApiExcludeController()
@Controller('platform/deploy-notice')
export class DeployNoticeController {
  constructor(private readonly notices: DeployNoticeService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(DeployTokenGuard)
  async post(@Body() dto: DeployNoticeDto): Promise<{ok: true}> {
    await this.notices.announce(dto);
    return {ok: true};
  }
}
