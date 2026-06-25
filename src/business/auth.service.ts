import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { BusinessService } from './business.service';
import { DatabaseService } from '../database/database.service';
import { staff, roles } from '../database/schema';
import { verifyPassword } from '../utils/password';
import { JwtPayload } from './jwt-auth.guard';
import { IBusiness } from './types';

// Sentinel meaning "all menus" — used for the business owner.
const ALL_MENUS = '*';

@Injectable()
export class AuthService {
  constructor(
    private readonly businessService: BusinessService,
    private readonly dbService: DatabaseService,
    private readonly jwtService: JwtService,
  ) {}

  async validateBusiness(login: string, password: string): Promise<IBusiness> {
    const business = await this.businessService.findByLogin(login);

    if (!business) {
      throw new UnauthorizedException('Invalid login credentials');
    }

    if (!business.isActive) {
      throw new UnauthorizedException('Business account is inactive');
    }

    const isPasswordValid = verifyPassword(password, business.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid login credentials');
    }

    // Remove password from returned object
    const { password: _, ...businessWithoutPassword } = business;
    return businessWithoutPassword;
  }

  /**
   * Unified login: try the business owner account first, then fall back to a
   * staff account with the same login.
   */
  async login(login: string, password: string) {
    const business = await this.businessService.findByLogin(login);

    if (business) {
      if (!business.isActive) {
        throw new UnauthorizedException('Business account is inactive');
      }
      if (!verifyPassword(password, business.password)) {
        throw new UnauthorizedException('Invalid login credentials');
      }
      return this.buildOwnerSession(business);
    }

    // Not a business login — try staff.
    const [member] = await this.dbService.db
      .select()
      .from(staff)
      .where(eq(staff.login, login))
      .limit(1);

    if (!member) {
      throw new UnauthorizedException('Invalid login credentials');
    }
    if (!member.isActive) {
      throw new UnauthorizedException('Staff account is inactive');
    }
    if (!verifyPassword(password, member.password)) {
      throw new UnauthorizedException('Invalid login credentials');
    }

    return this.buildStaffSession(member);
  }

  private signToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload);
  }

  private buildOwnerSession(business: {
    id: string;
    name: string;
    email: string;
    login: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const accessToken = this.signToken({
      sub: business.id,
      businessId: business.id,
      login: business.login,
      type: 'business',
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      business: {
        id: business.id,
        name: business.name,
        email: business.email,
        login: business.login,
        isActive: business.isActive,
        createdAt: business.createdAt,
        updatedAt: business.updatedAt,
      },
      account: {
        type: 'business' as const,
        id: business.id,
        name: business.name,
        login: business.login,
        roleId: null,
        roleName: null,
        menuKeys: [ALL_MENUS],
      },
    };
  }

  private async buildStaffSession(member: typeof staff.$inferSelect) {
    const [role] = await this.dbService.db
      .select()
      .from(roles)
      .where(eq(roles.id, member.roleId))
      .limit(1);

    if (!role || !role.isActive) {
      throw new UnauthorizedException('Staff role is missing or inactive');
    }

    const business = await this.businessService.findById(member.businessId);
    if (!business || !business.isActive) {
      throw new UnauthorizedException('Business account is inactive');
    }

    const accessToken = this.signToken({
      sub: member.id,
      businessId: member.businessId,
      login: member.login,
      type: 'staff',
      roleId: member.roleId,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      business: {
        id: business.id,
        name: business.name,
        email: business.email,
        login: business.login,
        isActive: business.isActive,
        createdAt: business.createdAt,
        updatedAt: business.updatedAt,
      },
      account: {
        type: 'staff' as const,
        id: member.id,
        name: member.name,
        login: member.login,
        roleId: role.id,
        roleName: role.name,
        menuKeys: role.menuKeys ?? [],
      },
    };
  }
}
