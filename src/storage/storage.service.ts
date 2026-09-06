import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {Injectable, Logger} from '@nestjs/common';

export interface UploadOptions {
  /** S3 key (path) for the object. If not set, a key is generated. */
  key?: string;
  /** MIME type, e.g. image/jpeg */
  contentType?: string;
  /** Optional folder prefix, e.g. 'products' or 'categories' */
  prefix?: string;
}

// Default S3 config (override via env later)
const DEFAULT_S3 = {
  bucket: 'KPOS',
  region: 'us-east-1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  accessKeyId: '0LP3ETM9ZQHUFVHMA88G',
  secretAccessKey: 'qsSGUr2LXoH1DTuGttvLxiQBZnuzmKOhe3gQCJeE',
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null = null;
  private readonly bucket: string;
  private readonly region: string;
  private readonly publicBaseUrl: string | null;
  private readonly enabled: boolean;
  /** Cached bucket check so concurrent uploads only probe S3 once. */
  private bucketReady: Promise<void> | null = null;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? DEFAULT_S3.bucket;
    this.region =
      process.env.AWS_REGION ?? process.env.S3_REGION ?? DEFAULT_S3.region;
    const endpoint = process.env.S3_ENDPOINT ?? DEFAULT_S3.endpoint;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? DEFAULT_S3.accessKeyId;
    const secretAccessKey =
      process.env.AWS_SECRET_ACCESS_KEY ?? DEFAULT_S3.secretAccessKey;

    this.publicBaseUrl =
      process.env.S3_PUBLIC_BASE_URL ??
      (endpoint && this.bucket
        ? `${endpoint.replace(/\/$/, '')}/${this.bucket}`
        : null);
    this.enabled = Boolean(this.bucket && accessKeyId && secretAccessKey);

    if (this.enabled) {
      this.client = new S3Client({
        region: this.region,
        credentials: {accessKeyId, secretAccessKey},
        endpoint,
        forcePathStyle: true,
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Upload a buffer to S3 and return the public URL and key.
   */
  async upload(
    buffer: Buffer,
    options: UploadOptions = {},
  ): Promise<{url: string; key: string}> {
    if (!this.enabled || !this.client) {
      throw new Error(
        'S3 storage is not configured. Set S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.',
      );
    }

    const key =
      options.key ?? this.generateKey(options.prefix, options.contentType);

    await this.ensureBucket();

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: options.contentType ?? 'application/octet-stream',
      }),
    );

    return {url: this.getUrl(key), key};
  }

  /**
   * Return the public URL for an S3 key. Uses S3_PUBLIC_BASE_URL if set,
   * otherwise builds the standard S3 URL (bucket in region).
   */
  getUrl(key: string): string {
    if (this.publicBaseUrl) {
      const base = this.publicBaseUrl.replace(/\/$/, '');
      return `${base}/${key}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  /**
   * Delete an object by key.
   */
  async delete(key: string): Promise<void> {
    if (!this.enabled || !this.client) return;

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  /**
   * Check if an object exists.
   */
  async exists(key: string): Promise<boolean> {
    if (!this.enabled || !this.client) return false;

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create the bucket on first use if it is missing. The check is cached; a
   * failure clears the cache so the next upload retries instead of being stuck.
   */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= this.createBucketIfMissing().catch((e) => {
      this.bucketReady = null;
      throw e;
    });
    return this.bucketReady;
  }

  private async createBucketIfMissing(): Promise<void> {
    const client = this.client;
    if (!client) return;

    try {
      await client.send(new HeadBucketCommand({Bucket: this.bucket}));
      return;
    } catch (e) {
      if (!isBucketMissing(e)) throw e;
    }

    try {
      await client.send(new CreateBucketCommand({Bucket: this.bucket}));
      this.logger.log(`Created S3 bucket "${this.bucket}"`);
    } catch (e) {
      // Another instance may have created it first.
      if (!isBucketTaken(e)) throw e;
      return;
    }

    // Uploads are served straight from <img src> (receipts, storefront), so
    // objects must be readable without credentials.
    try {
      await client.send(
        new PutBucketPolicyCommand({
          Bucket: this.bucket,
          Policy: publicReadPolicy(this.bucket),
        }),
      );
    } catch (e) {
      this.logger.warn(
        `Bucket "${this.bucket}" created, but its public-read policy failed ` +
          `(${errName(e)}). Set it manually or uploaded images will 403.`,
      );
    }
  }

  private generateKey(prefix?: string, contentType?: string): string {
    const ext = contentType?.startsWith('image/')
      ? contentType.replace('image/', '')
      : 'bin';
    const safeExt = ext === 'jpeg' ? 'jpg' : ext.split(';')[0];
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const filename = `${name}.${safeExt}`;
    return prefix ? `${prefix}/${filename}` : filename;
  }
}

function errName(e: unknown): string {
  const err = e as {name?: string; Code?: string};
  return err?.name ?? err?.Code ?? 'unknown error';
}

function httpStatus(e: unknown): number | undefined {
  return (e as {$metadata?: {httpStatusCode?: number}})?.$metadata
    ?.httpStatusCode;
}

/** HeadBucket reports a missing bucket as NotFound/NoSuchBucket (404). */
function isBucketMissing(e: unknown): boolean {
  const name = errName(e);
  return name === 'NotFound' || name === 'NoSuchBucket' || httpStatus(e) === 404;
}

/** CreateBucket race: another instance already created/owns the bucket. */
function isBucketTaken(e: unknown): boolean {
  const name = errName(e);
  return (
    name === 'BucketAlreadyOwnedByYou' ||
    name === 'BucketAlreadyExists' ||
    httpStatus(e) === 409
  );
}

function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {AWS: ['*']},
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}
