import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { businesses, type Business, type NewBusiness } from '../database/schema';
import { eq, or } from 'drizzle-orm';
import { hashPassword } from '../utils/password';
import { generateId } from '../utils/uuid';

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
      throw new ConflictException('Email or login already exists');
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

    return business;
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
      throw new NotFoundException('Business not found');
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
      throw new NotFoundException('Business not found');
    }

    await this.dbService.db.delete(businesses).where(eq(businesses.id, id));
  }
}
