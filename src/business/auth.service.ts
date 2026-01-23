import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BusinessService } from './business.service';
import { verifyPassword } from '../utils/password';
import { JwtPayload } from './jwt-auth.guard';
import { IBusiness } from './types';

@Injectable()
export class AuthService {
  constructor(
    private readonly businessService: BusinessService,
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

  async login(login: string, password: string) {
    const business = await this.validateBusiness(login, password);

    const payload: JwtPayload = {
      sub: business.id,
      login: business.login,
    };

    const accessToken = this.jwtService.sign(payload);

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
    };
  }
}
