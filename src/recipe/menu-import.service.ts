import {Injectable} from '@nestjs/common';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {products, recipeItems} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {getBusinessType} from '../common/business-type';
import {generateId} from '../utils/uuid';
import {CategoryService} from '../category/category.service';
import {ProductService} from '../product/product.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {RecipeService} from './recipe.service';
import {MenuImportDto} from './dto/menu-import.dto';

export interface MenuImportResult {
  created: number;
  updated: number;
  categoriesCreated: number;
  skipped: {name: string; reason: 'duplicate_in_file'}[];
}

/** "  Латте  сингл " and "латте сингл" are the same dish. */
const key = (name: string) =>
  name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * Bring a menu in from another till (Poster's dish export): every row becomes a
 * dish card with its price, its category and — while it has no recipe — the
 * cost the old system had typed for it. Matched by name, so running the same
 * file again updates the cards instead of doubling them; a dish whose recipe is
 * already entered keeps the cost its recipe gives.
 *
 * Not one transaction: each card goes through ProductService.create (limits,
 * default branch, caches) and the recipe save (cost re-derivation). A run cut
 * short is finished by running the same file again.
 */
@Injectable()
export class MenuImportService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly productService: ProductService,
    private readonly categoryService: CategoryService,
    private readonly subscriptionService: SubscriptionService,
    private readonly recipeService: RecipeService,
  ) {}

  async importMenu(
    businessId: string,
    dto: MenuImportDto,
  ): Promise<MenuImportResult> {
    if ((await getBusinessType(this.dbService.db, businessId)) !== 'food') {
      throw new AppException(ErrorCode.PRODUCT_KIND_FOOD_ONLY);
    }

    const skipped: MenuImportResult['skipped'] = [];
    const seen = new Set<string>();
    const rows = dto.rows
      .map((r) => ({...r, name: r.name.trim().replace(/\s+/g, ' ')}))
      .filter((r) => {
        const k = key(r.name);
        if (seen.has(k)) {
          skipped.push({name: r.name, reason: 'duplicate_in_file'});
          return false;
        }
        seen.add(k);
        return true;
      });

    const dishes = await this.dbService.db
      .select({id: products.id, name: products.name})
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.kind, 'dish'),
          eq(products.isActive, true),
        ),
      );
    const dishByName = new Map(dishes.map((d) => [key(d.name), d.id]));
    const withRecipe = new Set(
      (
        await this.dbService.db
          .selectDistinct({productId: recipeItems.productId})
          .from(recipeItems)
          .where(eq(recipeItems.businessId, businessId))
      ).map((r) => r.productId),
    );

    // Refuse up front rather than stop halfway at the plan's card limit.
    const toCreate = rows.filter((r) => !dishByName.has(key(r.name))).length;
    const {productsLimit} =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    if (productsLimit !== null) {
      const current = await this.productService.getCount(businessId);
      if (current + toCreate > productsLimit) {
        throw new AppException(ErrorCode.PRODUCT_LIMIT_REACHED, {
          limit: productsLimit,
        });
      }
    }

    const categoryByName = new Map(
      (await this.categoryService.findAll(businessId)).map((c) => [
        key(c.name),
        c.id,
      ]),
    );
    let categoriesCreated = 0;
    const categoryId = async (name?: string): Promise<string | undefined> => {
      const clean = name?.trim().replace(/\s+/g, ' ');
      if (!clean) return undefined;
      const known = categoryByName.get(key(clean));
      if (known) return known;
      const created = await this.categoryService.create(businessId, {
        id: generateId(),
        name: clean,
      });
      categoryByName.set(key(clean), created.id);
      categoriesCreated++;
      return created.id;
    };

    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const catId = await categoryId(row.category);
      let id = dishByName.get(key(row.name));
      if (id) {
        await this.productService.update(businessId, id, {
          priceOut: row.price.toFixed(2),
          ...(catId ? {categoryId: catId} : {}),
        });
        updated++;
      } else {
        const card = await this.productService.create(businessId, {
          name: row.name,
          priceIn: '0',
          priceOut: row.price.toFixed(2),
          quantity: 0,
          kind: 'dish',
          ...(catId ? {categoryId: catId} : {}),
        });
        id = card.id;
        dishByName.set(key(row.name), id);
        created++;
      }
      // The typed cost stands in for the recipe until one is entered.
      if (row.cost !== undefined && !withRecipe.has(id)) {
        await this.recipeService.saveRecipe(businessId, id, {
          lines: [],
          manualCost: row.cost,
        });
      }
    }

    return {created, updated, categoriesCreated, skipped};
  }
}
