import {Body, Controller, Get, Post, Req, Res, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {Request, Response} from 'express';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {IBusiness} from '../business/types';
import {MinTier} from '../subscription/required-tier.decorator';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {SubscriptionService} from '../subscription/subscription.service';
import {AiSettingsService} from './ai-settings.service';
import {AiService} from './ai.service';
import {PROVIDER_MODELS} from './providers/llm-provider.interface';
import {AskAiDto} from './dto/ask-ai.dto';
import {AiToolsService} from './tools/ai-tools.service';

/**
 * The assistant itself. Pro tier, matching the extended-analytics reports it
 * reads — a basic plan's assistant could only reach the operational half.
 */
@ApiTags('ai')
@Controller('ai')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('pro')
@ApiBearerAuth('JWT-auth')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly tools: AiToolsService,
    private readonly subscriptions: SubscriptionService,
    private readonly settings: AiSettingsService,
  ) {}

  @Get('capabilities')
  @ApiOperation({summary: 'Ushbu tarif uchun mavjud tool’lar ro‘yxati'})
  async capabilities(@CurrentBusiness() business: IBusiness) {
    const [tier, view, models] = await Promise.all([
      this.subscriptions.getEffectiveTier(business.id),
      this.settings.getView(business.id),
      // Cached an hour; safe for staff accounts because it never touches the key.
      this.settings.listModelsForBusiness(business.id),
    ]);

    return {
      tier,
      provider: view.provider,
      // The saved default, which the chat picker starts on.
      model: view.model,
      configured: view.hasKey && view.enabled,
      models: models.length ? models : PROVIDER_MODELS[view.provider],
      tools: this.tools.listFor(tier).map((t) => ({
        name: t.name,
        label: this.tools.labelFor(t.name),
      })),
    };
  }

  /**
   * Streams an answer as Server-Sent Events.
   *
   * POST rather than GET because the question and history go in the body, which
   * also means the browser cannot use `EventSource` (it sends no Authorization
   * header) — the frontend reads this with `fetch` + a ReadableStream reader.
   */
  @Post('ask')
  @ApiOperation({summary: 'Savol berish (SSE oqim)'})
  async ask(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: AskAiDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Tells nginx/Coolify's proxy not to buffer, which would otherwise hold the
    // whole answer back and defeat streaming entirely.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // Heartbeat: a comment frame keeps idle proxies from dropping the socket
    // while the model thinks or a slow report runs.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    try {
      const stream = this.ai.ask(
        {
          businessId: business.id,
          businessName: business.name,
          locale: dto.locale ?? 'uz',
          question: dto.question,
          history: dto.history ?? [],
          model: dto.model,
        },
        controller.signal,
      );

      for await (const event of stream) {
        if (res.writableEnded) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }
}
