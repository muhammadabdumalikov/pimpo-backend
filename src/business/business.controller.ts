import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { BusinessService } from './business.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentBusiness } from './decorators/current-business.decorator';
import { CurrentAccount } from './decorators/current-account.decorator';
import { IBusiness, IAccount } from './types';
import { CreateBusinessDto } from './dto/create-business.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { BusinessResponseDto } from './dto/business-response.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { CurrentUserResponseDto } from './dto/current-user-response.dto';

@ApiTags('businesses')
@Controller('businesses')
export class BusinessController {
  constructor(
    private readonly businessService: BusinessService,
    private readonly authService: AuthService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new business' })
  @ApiResponse({
    status: 201,
    description: 'Business created successfully',
    type: BusinessResponseDto,
  })
  @ApiResponse({ status: 409, description: 'Email or login already exists' })
  async create(@Body() createBusinessDto: CreateBusinessDto) {
    const business = await this.businessService.create(createBusinessDto);
    // Remove password from response
    const { password: _, ...businessWithoutPassword } = business;
    return {
      message: 'Business created successfully',
      business: businessWithoutPassword,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login and get JWT token' })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    type: LoginResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid login credentials' })
  async login(@Body() loginDto: LoginDto) {
    return await this.authService.login(loginDto.login, loginDto.password);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get all businesses' })
  @ApiResponse({
    status: 200,
    description: 'List of all businesses',
    type: [BusinessResponseDto],
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async findAll() {
    const businesses = await this.businessService.findAll();
    // Remove passwords from response
    return businesses.map(({ password: _, ...business }) => business);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current authenticated business profile' })
  @ApiResponse({
    status: 200,
    description: 'Current business profile',
    type: BusinessResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentBusiness() business: IBusiness) {
    return business;
  }

  @Get('me/account')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary:
      'Get the current authenticated user (owner or staff) with the permissions ' +
      '(menu keys) that drive the frontend menus and access checks',
  })
  @ApiResponse({
    status: 200,
    description: 'Current account + owning business, with allowed menu keys',
    type: CurrentUserResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@CurrentAccount() account: IAccount) {
    return this.authService.getCurrentUser(account);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get business by ID' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  @ApiResponse({
    status: 200,
    description: 'Business found',
    type: BusinessResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async findOne(@Param('id') id: string) {
    const business = await this.businessService.findById(id);
    if (!business) {
      throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    }
    // Remove password from response
    const { password: _, ...businessWithoutPassword } = business;
    return businessWithoutPassword;
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update business' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  @ApiResponse({
    status: 200,
    description: 'Business updated successfully',
    type: BusinessResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async update(
    @Param('id') id: string,
    @Body() updateBusinessDto: UpdateBusinessDto,
  ) {
    const business = await this.businessService.update(id, updateBusinessDto);
    // Remove password from response
    const { password: _, ...businessWithoutPassword } = business;
    return {
      message: 'Business updated successfully',
      business: businessWithoutPassword,
    };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete business' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  @ApiResponse({ status: 204, description: 'Business deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async remove(@Param('id') id: string) {
    await this.businessService.delete(id);
  }
}
