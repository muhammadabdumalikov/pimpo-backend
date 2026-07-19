import { Injectable } from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { BusinessService } from './business.service';
import { DatabaseService } from '../database/database.service';
import { staff, roles } from '../database/schema';
import { verifyPassword } from '../utils/password';
import { JwtPayload } from './jwt-auth.guard';
import { IBusiness, IAccount } from './types';

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
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }

    if (!business.isActive) {
      throw new AppException(ErrorCode.BUSINESS_INACTIVE);
    }

    const isPasswordValid = verifyPassword(password, business.password);

    if (!isPasswordValid) {
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
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
        throw new AppException(ErrorCode.BUSINESS_INACTIVE);
      }
      if (!verifyPassword(password, business.password)) {
        throw new AppException(ErrorCode.INVALID_CREDENTIALS);
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
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }
    if (!member.isActive) {
      throw new AppException(ErrorCode.STAFF_INACTIVE);
    }
    if (!verifyPassword(password, member.password)) {
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }

    return this.buildStaffSession(member);
  }

  /**
   * Re-resolve the acting account (owner or staff) together with its current
   * permissions. Backs `GET /businesses/me/account`, letting the frontend
   * refresh profile + menuKeys without re-logging in — so role/permission edits
   * take effect immediately. Reads live from the DB rather than the JWT payload.
   */
  async getCurrentUser(identity: IAccount) {
    if (identity.type === 'business') {
      const business = await this.businessService.findById(identity.id);
      if (!business || !business.isActive) {
        throw new AppException(ErrorCode.BUSINESS_INACTIVE);
      }
      const { password: _pw, ...businessWithoutPassword } = business;
      return {
        business: businessWithoutPassword,
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

    // Staff account — re-read staff + role so permission edits take effect.
    const [member] = await this.dbService.db
      .select()
      .from(staff)
      .where(eq(staff.id, identity.id))
      .limit(1);

    if (!member || !member.isActive) {
      throw new AppException(ErrorCode.STAFF_INACTIVE);
    }

    const [role] = await this.dbService.db
      .select()
      .from(roles)
      .where(eq(roles.id, member.roleId))
      .limit(1);

    if (!role || !role.isActive) {
      throw new AppException(ErrorCode.STAFF_ROLE_INACTIVE);
    }

    const business = await this.businessService.findById(member.businessId);
    if (!business || !business.isActive) {
      throw new AppException(ErrorCode.BUSINESS_INACTIVE);
    }

    const { password: _pw, ...businessWithoutPassword } = business;
    return {
      business: businessWithoutPassword,
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
      throw new AppException(ErrorCode.STAFF_ROLE_INACTIVE);
    }

    const business = await this.businessService.findById(member.businessId);
    if (!business || !business.isActive) {
      throw new AppException(ErrorCode.BUSINESS_INACTIVE);
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
