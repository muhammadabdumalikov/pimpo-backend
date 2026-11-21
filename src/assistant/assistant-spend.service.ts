import {Injectable} from '@nestjs/common';
import {and, eq, gte, lte, sql, type SQL} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {businesses, customerChatMessages} from '../database/schema';
import {businessDayEnd, businessDayStart} from '../common/business-time';
import {assistantModel} from '../subscription/ai-usage.service';
import {UsdRateService} from '../subscription/usd-rate.service';
import {
  botSpend,
  botSummary,
  type BotSpendGroup,
  type PlatformAiBotSpend,
  type PlatformAiBotSummary,
} from './assistant-spend';

/**
 * Platform console: the customer AI bot's cost against what shops paid for
 * it, over any days (both inclusive, business zone; none = all time). The
 * runs are grouped in SQL by shop, model and paid-or-not, and priced in
 * assistant-spend.ts.
 */
@Injectable()
export class AssistantSpendService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly rates: UsdRateService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  private async groups(
    from: string | undefined,
    to: string | undefined,
    businessId?: string,
  ): Promise<BotSpendGroup[]> {
    const m = customerChatMessages;
    const paid = sql<boolean>`coalesce(${m.costUzs}, 0) > 0`;
    const filters: (SQL | undefined)[] = [
      eq(m.role, 'bot'),
      // A model run that used tokens — a failed one too: it cost us.
      sql`coalesce(${m.tokensIn}, 0) + coalesce(${m.tokensOut}, 0) > 0`,
      businessId ? eq(m.businessId, businessId) : undefined,
      from ? gte(m.createdAt, businessDayStart(from)) : undefined,
      to ? lte(m.createdAt, businessDayEnd(to)) : undefined,
    ];
    const rows = await this.db
      .select({
        businessId: m.businessId,
        name: businesses.name,
        model: m.model,
        paid,
        runs: sql<number>`count(*)::int`,
        tokensIn: sql<string>`coalesce(sum(${m.tokensIn}), 0)`,
        tokensOut: sql<string>`coalesce(sum(${m.tokensOut}), 0)`,
        charged: sql<string>`coalesce(sum(${m.costUzs}), 0)`,
      })
      .from(m)
      .innerJoin(businesses, eq(businesses.id, m.businessId))
      .where(and(...filters))
      .groupBy(m.businessId, businesses.name, m.model, paid);
    return rows.map((r) => ({
      businessId: r.businessId,
      name: r.name,
      model: r.model,
      paid: !!r.paid,
      runs: Number(r.runs),
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      chargedUzs: Number(r.charged),
    }));
  }

  async platformSummary(from?: string, to?: string): Promise<PlatformAiBotSummary> {
    const [groups, usdRate] = await Promise.all([
      this.groups(from, to),
      this.rates.get(),
    ]);
    const {provider, model} = assistantModel();
    return botSummary(groups, {usdRate, provider, model});
  }

  async businessSpend(
    businessId: string,
    from?: string,
    to?: string,
  ): Promise<PlatformAiBotSpend> {
    const [groups, usdRate] = await Promise.all([
      this.groups(from, to, businessId),
      this.rates.get(),
    ]);
    return botSpend(groups, {usdRate, provider: assistantModel().provider});
  }
}
