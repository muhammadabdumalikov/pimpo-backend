import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UserController {
    constructor(private readonly userService: UserService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create a new user' })
    @ApiResponse({
        status: 201,
        description: 'User created successfully',
    })
    @ApiResponse({ status: 409, description: 'User with this phone number already exists' })
    async create(
        @CurrentBusiness() business: IBusiness,
        @Body() createUserDto: CreateUserDto,
    ) {
        const user = await this.userService.create(business.id, createUserDto);
        return {
            message: 'User created successfully',
            user,
        };
    }

    @Get()
    @ApiOperation({ summary: 'Get all users for current business' })
    @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
    @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
    @ApiQuery({ name: 'search', required: false, type: String, description: 'Search term' })
    @ApiResponse({
        status: 200,
        description: 'List of users',
    })
    async findAll(
        @CurrentBusiness() business: IBusiness,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
        @Query('search') search?: string,
    ) {
        const result = await this.userService.findAll(business.id, {
            page: page ? parseInt(page, 10) : undefined,
            limit: limit ? parseInt(limit, 10) : undefined,
            search,
        });
        return result;
    }

    @Get('count')
    @ApiOperation({ summary: 'Get total user count for current business' })
    @ApiResponse({
        status: 200,
        description: 'User count',
    })
    async getCount(@CurrentBusiness() business: IBusiness) {
        const count = await this.userService.getCount(business.id);
        return { count };
    }

    @Get('phone/:phone')
    @ApiOperation({ summary: 'Get user by phone number' })
    @ApiParam({ name: 'phone', description: 'Phone number' })
    @ApiResponse({
        status: 200,
        description: 'User details',
    })
    @ApiResponse({ status: 404, description: 'User not found' })
    async findByPhone(
        @CurrentBusiness() business: IBusiness,
        @Param('phone') phone: string,
    ) {
        const user = await this.userService.findByPhone(business.id, phone);
        if (!user) {
            throw new AppException(ErrorCode.USER_NOT_FOUND);
        }
        return user;
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a user by ID' })
    @ApiParam({ name: 'id', description: 'User ID' })
    @ApiResponse({
        status: 200,
        description: 'User details',
    })
    @ApiResponse({ status: 404, description: 'User not found' })
    async findOne(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
    ) {
        const user = await this.userService.findOne(business.id, id);
        if (!user) {
            throw new AppException(ErrorCode.USER_NOT_FOUND);
        }
        return user;
    }

    @Put(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Update a user' })
    @ApiParam({ name: 'id', description: 'User ID' })
    @ApiResponse({
        status: 200,
        description: 'User updated successfully',
    })
    @ApiResponse({ status: 404, description: 'User not found' })
    @ApiResponse({ status: 409, description: 'User with this phone number already exists' })
    async update(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
        @Body() updateUserDto: UpdateUserDto,
    ) {
        const user = await this.userService.update(business.id, id, updateUserDto);
        return {
            message: 'User updated successfully',
            user,
        };
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete (soft) a user' })
    @ApiParam({ name: 'id', description: 'User ID' })
    @ApiResponse({
        status: 200,
        description: 'User deleted successfully',
    })
    @ApiResponse({ status: 404, description: 'User not found' })
    async remove(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
    ) {
        await this.userService.remove(business.id, id);
        return {
            message: 'User deleted successfully',
        };
    }
}
