import {Controller, Delete, Get, Param, Post, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiParam, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {PriceStepService} from './price-step.service';

/**
 * A product's waiting prices ("navbatdagi narx"). Same right as changing the
 * card's price, since every action here is exactly that.
 */
@ApiTags('products')
@Controller('products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class PriceStepController {
  constructor(private readonly priceSteps: PriceStepService) {}

  @Get(':id/price-steps')
  @RequirePermission('product:update')
  @ApiOperation({
    summary: "A product's waiting lower prices, chain order",
    description:
      "Each row is a delivery's lower selling price that takes effect when " +
      'the stock received before it (`oldStock`, per branch) has sold out.',
  })
  @ApiParam({name: 'id', description: 'Product ID'})
  async list(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    return {steps: await this.priceSteps.list(business.id, id)};
  }

  @Post(':id/price-steps/:stepId/apply')
  @RequirePermission('product:update')
  @ApiOperation({
    summary: 'Apply a waiting price now (and every one ahead of it)',
  })
  async applyNow(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Param('stepId') stepId: string,
  ) {
    const applied = await this.priceSteps.applyNow(
      business.id,
      id,
      stepId,
      account,
    );
    return {applied};
  }

  @Delete(':id/price-steps/:stepId')
  @RequirePermission('product:update')
  @ApiOperation({summary: 'Cancel one waiting price'})
  async cancelOne(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Param('stepId') stepId: string,
  ) {
    return this.priceSteps.cancel(business.id, id, stepId, account);
  }

  @Delete(':id/price-steps')
  @RequirePermission('product:update')
  @ApiOperation({summary: "Cancel all of a product's waiting prices"})
  async cancelAll(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    return this.priceSteps.cancel(business.id, id, undefined, account);
  }

  @Get(':id/stock-costs')
  @RequirePermission('product:update')
  @ApiOperation({
    summary: 'Stock on hand grouped by purchase price, dearest first',
    description:
      'Every branch, base UZS. The product form warns with it when a ' +
      'selling price is set below what part of that stock cost.',
  })
  async stockCosts(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return {lots: await this.priceSteps.stockCosts(business.id, id)};
  }
}
