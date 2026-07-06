import { Injectable, Logger } from '@nestjs/common';

export interface ExternalBarcodeResult {
  name: string;
  image: string | null;
  categoryName: string | null;
  /** Where the data came from, e.g. 'openfoodfacts' | 'gs1'. Stored on the catalog row. */
  source: string;
}

// External barcode providers, tried when a scanned barcode is not in our own or
// the shared community catalog. Results get cached into global_barcodes by the
// caller, so each barcode only ever hits the network once.
@Injectable()
export class BarcodeLookupService {
  private readonly logger = new Logger(BarcodeLookupService.name);

  // Keep the on-blur lookup snappy — a slow provider must not stall the form.
  private readonly timeoutMs = 4000;

  async lookup(barcode: string): Promise<ExternalBarcodeResult | null> {
    // Prefer the official GS1 source (most authoritative) when configured, then
    // fall back to the free Open Food Facts database.
    return (
      (await this.lookupGs1(barcode)) ??
      (await this.lookupOpenFoodFacts(barcode))
    );
  }

  private async fetchJson(
    url: string,
    headers?: Record<string, string>,
  ): Promise<any | null> {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          // Open Food Facts asks every client to identify itself.
          'User-Agent': 'KPOS-POS/1.0 (https://pimpo.uz)',
          ...headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      this.logger.warn(
        `Barcode lookup request failed for ${url}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // Open Food Facts — free, no API key. Great coverage for packaged food/drinks,
  // weaker for local non-food goods. https://world.openfoodfacts.org/data
  private async lookupOpenFoodFacts(
    barcode: string,
  ): Promise<ExternalBarcodeResult | null> {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
      barcode,
    )}.json?fields=product_name,brands,image_url,categories`;

    const data = await this.fetchJson(url);
    if (!data || data.status !== 1 || !data.product) return null;

    const p = data.product;
    const name: string =
      (p.product_name && String(p.product_name).trim()) ||
      (p.brands && String(p.brands).split(',')[0].trim()) ||
      '';
    if (!name) return null;

    const categoryName = p.categories
      ? String(p.categories).split(',')[0].trim().slice(0, 255)
      : null;

    return {
      name: name.slice(0, 255),
      image: p.image_url ? String(p.image_url).slice(0, 500) : null,
      categoryName,
      source: 'openfoodfacts',
    };
  }

  // Official GS1 provider (e.g. GS1 Uzbekistan / Verified by GS1). Opt-in via env:
  //   GS1_API_URL  — endpoint that accepts the GTIN as a `gtin` query param
  //   GS1_API_KEY  — optional bearer token
  // Response field names vary by provider, so we map defensively. Adjust the
  // mapping to the concrete provider once its contract is known.
  private async lookupGs1(
    barcode: string,
  ): Promise<ExternalBarcodeResult | null> {
    const baseUrl = process.env.GS1_API_URL;
    if (!baseUrl) return null;

    const apiKey = process.env.GS1_API_KEY;
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}gtin=${encodeURIComponent(barcode)}`;

    const data = await this.fetchJson(
      url,
      apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    );
    if (!data) return null;

    // Some providers wrap the payload (e.g. { product: {...} } or { data: {...} }).
    const p = data.product ?? data.data ?? data;
    const name: string | undefined =
      p.productName ?? p.name ?? p.product_name ?? p.brandName;
    if (!name) return null;

    return {
      name: String(name).trim().slice(0, 255),
      image: (p.image ?? p.imageUrl ?? p.productImageUrl ?? null)
        ? String(p.image ?? p.imageUrl ?? p.productImageUrl).slice(0, 500)
        : null,
      categoryName: (p.category ?? p.categoryName ?? null)
        ? String(p.category ?? p.categoryName).slice(0, 255)
        : null,
      source: 'gs1',
    };
  }
}
