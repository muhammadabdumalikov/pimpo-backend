import { Injectable } from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import {
  businesses,
  businessSubscriptions,
  subscriptionPlans,
  type Business,
  type NewBusiness,
} from '../database/schema';
import { and, eq, or } from 'drizzle-orm';
import { hashPassword } from '../utils/password';
import { generateId } from '../utils/uuid';

// New businesses start on a 1-month free trial of the Standart (basic) plan.
const TRIAL_TIER = 'basic';
const TRIAL_DAYS = 30;

@Injectable()
export class BusinessService {
  constructor(private readonly dbService: DatabaseService) {}

  async create(data: {
    name: string;
    email: string;
    login: string;
    password: string;
  }): Promise<Business> {
    // Check if email or login already exists
    const existing = await this.dbService.db
      .select()
      .from(businesses)
      .where(
        or(
          eq(businesses.email, data.email),
          eq(businesses.login, data.login)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      throw new AppException(ErrorCode.EMAIL_OR_LOGIN_EXISTS);
    }

    // Hash password
    const hashedPassword = hashPassword(data.password);

    const newBusiness: NewBusiness = {
      id: generateId(),
      name: data.name,
      email: data.email,
      login: data.login,
      password: hashedPassword,
      isActive: true,
    };

    const [business] = await this.dbService.db
      .insert(businesses)
      .values(newBusiness)
      .returning();

    // Give the new business a 1-month Standart (basic) trial. Done here (via a
    // direct DB write) rather than through SubscriptionService to avoid a
    // circular module dependency (SubscriptionModule already imports
    // BusinessModule). If the basic plan is missing for any reason, registration
    // must still succeed — the business simply falls back to the internal floor.
    await this.startTrial(business.id).catch(() => undefined);

    return business;
  }

  /**
   * Seed a 1-month trial subscription on the Standart (basic) plan. `endDate`
   * marks when the trial expires; gating downgrades the business to the internal
   * floor once it passes (see SubscriptionService).
   */
  private async startTrial(businessId: string): Promise<void> {
    const [plan] = await this.dbService.db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.tier, TRIAL_TIER))
      .limit(1);
    if (!plan) return;

    // Don't double-seed if a subscription somehow already exists.
    const [existing] = await this.dbService.db
      .select({ id: businessSubscriptions.id })
      .from(businessSubscriptions)
      .where(
        and(
          eq(businessSubscriptions.businessId, businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      )
      .limit(1);
    if (existing) return;

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + TRIAL_DAYS);

    await this.dbService.db.insert(businessSubscriptions).values({
      id: generateId(),
      businessId,
      planId: plan.id,
      endDate,
      isActive: true,
    });
  }

  async findByLogin(login: string): Promise<Business | null> {
    const [business] = await this.dbService.db
      .select()
      .from(businesses)
      .where(eq(businesses.login, login))
      .limit(1);

    return business || null;
  }

  async findByEmail(email: string): Promise<Business | null> {
    const [business] = await this.dbService.db
      .select()
      .from(businesses)
      .where(eq(businesses.email, email))
      .limit(1);

    return business || null;
  }

  async findById(id: string): Promise<Business | null> {
    const [business] = await this.dbService.db
      .select()
      .from(businesses)
      .where(eq(businesses.id, id))
      .limit(1);

    return business || null;
  }

  async findAll(): Promise<Business[]> {
    return await this.dbService.db.select().from(businesses);
  }

  async update(
    id: string,
    data: Partial<Omit<NewBusiness, 'id' | 'createdAt'>>
  ): Promise<Business> {
    const business = await this.findById(id);
    if (!business) {
      throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    }

    // If password is being updated, hash it
    if (data.password) {
      data.password = hashPassword(data.password);
    }

    const updateData = {
      ...data,
      updatedAt: new Date(),
    };

    const [updated] = await this.dbService.db
      .update(businesses)
      .set(updateData)
      .where(eq(businesses.id, id))
      .returning();

    return updated;
  }

  async delete(id: string): Promise<void> {
    const business = await this.findById(id);
    if (!business) {
      throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    }

    await this.dbService.db.delete(businesses).where(eq(businesses.id, id));
  }
}
