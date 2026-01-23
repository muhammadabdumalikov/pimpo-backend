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
    NotFoundException,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import { DebtService } from './debt.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateDebtDto } from './dto/create-debt.dto';
import { UpdateDebtDto } from './dto/update-debt.dto';

@ApiTags('debts')
@Controller('debts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class DebtController {
    constructor(private readonly debtService: DebtService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create a new debt' })
    @ApiResponse({
        status: 201,
        description: 'Debt created successfully',
    })
    @ApiResponse({ status: 403, description: 'Debt limit reached' })
    async create(
        @CurrentBusiness() business: IBusiness,
        @Body() createDebtDto: CreateDebtDto,
    ) {
        const debt = await this.debtService.create(business.id, createDebtDto);
        return {
            message: 'Debt created successfully',
            debt,
        };
    }

    @Get()
    @ApiOperation({ summary: 'Get all debts for current business' })
    @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
    @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
    @ApiQuery({ name: 'search', required: false, type: String, description: 'Search term' })
    @ApiQuery({ name: 'status', required: false, type: String, description: 'Filter by status (Paid, Pending, Overdue)' })
    @ApiResponse({
        status: 200,
        description: 'List of debts',
    })
    async findAll(
        @CurrentBusiness() business: IBusiness,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
        @Query('search') search?: string,
        @Query('status') status?: string,
    ) {
        const result = await this.debtService.findAll(business.id, {
            page: page ? parseInt(page, 10) : undefined,
            limit: limit ? parseInt(limit, 10) : undefined,
            search,
            status,
        });
        return result;
    }

    @Get('count')
    @ApiOperation({ summary: 'Get total debt count for current business' })
    @ApiResponse({
        status: 200,
        description: 'Debt count',
    })
    async getCount(@CurrentBusiness() business: IBusiness) {
        const count = await this.debtService.getCount(business.id);
        return { count };
    }

    @Get('user/:userId')
    @ApiOperation({ summary: 'Get all debts for a specific user' })
    @ApiParam({ name: 'userId', description: 'User ID' })
    @ApiResponse({
        status: 200,
        description: 'List of debts for the user',
    })
    async findByUser(
        @CurrentBusiness() business: IBusiness,
        @Param('userId') userId: string,
    ) {
        const debts = await this.debtService.findByUser(business.id, userId);
        return { debts };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a debt by ID' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({
        status: 200,
        description: 'Debt details',
    })
    @ApiResponse({ status: 404, description: 'Debt not found' })
    async findOne(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
    ) {
        const debt = await this.debtService.findOne(business.id, id);
        if (!debt) {
            throw new NotFoundException('Debt not found');
        }
        return debt;
    }

    @Put(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Update a debt' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({
        status: 200,
        description: 'Debt updated successfully',
    })
    @ApiResponse({ status: 404, description: 'Debt not found' })
    async update(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
        @Body() updateDebtDto: UpdateDebtDto,
    ) {
        const debt = await this.debtService.update(business.id, id, updateDebtDto);
        return {
            message: 'Debt updated successfully',
            debt,
        };
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete a debt' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({
        status: 200,
        description: 'Debt deleted successfully',
    })
    @ApiResponse({ status: 404, description: 'Debt not found' })
    async remove(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
    ) {
        await this.debtService.remove(business.id, id);
        return {
            message: 'Debt deleted successfully',
        };
    }
}
