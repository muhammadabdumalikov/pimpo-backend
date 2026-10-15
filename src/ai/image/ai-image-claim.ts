import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../../database/database.service';
import {aiImageGenerations} from '../../database/schema';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** Where a saved product's image came from, as far as AI images go. */
export type AiImageOrigin = 'photo' | 'text';

/**
 * Called when a product is saved with `imageUrl`: if that URL is an AI
 * packshot this shop made, mark it accepted (the weekly sweep then keeps it)
 * and say how it was made.
 *
 * The answer decides the shared barcode catalogue (Q8): a 'photo' packshot is
 * the real pack and may fill another shop's empty image; a 'text' one is the
 * model's guess at the packaging and never leaves this shop.
 *
 * A plain function on the transaction rather than a service, so the product
 * module needs nothing from the AI module.
 */
export async function claimAiImageTx(
  tx: Tx,
  businessId: string,
  productId: string,
  imageUrl: string | null | undefined,
): Promise<AiImageOrigin | null> {
  if (!imageUrl) return null;
  const [row] = await tx
    .update(aiImageGenerations)
    .set({acceptedAt: new Date(), productId})
    .where(
      and(
        eq(aiImageGenerations.businessId, businessId),
        eq(aiImageGenerations.imageUrl, imageUrl),
        eq(aiImageGenerations.kind, 'image'),
      ),
    )
    .returning({mode: aiImageGenerations.mode});
  if (!row) return null;
  return row.mode === 'photo' ? 'photo' : 'text';
}
