import {ClientHttp2Session, ClientHttp2Stream, connect, constants, OutgoingHttpHeaders} from 'node:http2';
import {createPrivateKey, KeyObject, sign} from 'node:crypto';

/**
 * Apple Push Notification service for the KPOS iPhone app (pimpo/IOS.md,
 * stage 1): token-based auth (a .p8 key), HTTP/2, no dependency.
 *
 * The app sends the same events as web push (notification.service), so the
 * message mirrors the web payload: `{ title, body, url, tag, id }`, with the
 * title/body in `aps.alert` and `url` beside it for the tap.
 */

export type ApnsEnvironment = 'sandbox' | 'production';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  key: KeyObject;
  /** The app's bundle id. */
  topic: string;
}

/**
 * APNS_KEY_ID + APNS_TEAM_ID + APNS_PRIVATE_KEY (the .p8 file's PEM; "\n"
 * escapes allowed for one-line env panels), APNS_TOPIC (default uz.kpos.app).
 * Null when any of the three is missing: iPhone push is then off. Throws on a
 * key that is present but unreadable — the caller logs it and stays off.
 */
export function readApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const pem = env.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (!keyId || !teamId || !pem) return null;
  return {
    keyId,
    teamId,
    key: createPrivateKey(pem),
    topic: env.APNS_TOPIC?.trim() || 'uz.kpos.app',
  };
}

/** The provider token: an ES256 JWT `{alg, kid}.{iss, iat}` signed with the .p8 key. */
export function providerToken(cfg: Pick<ApnsConfig, 'keyId' | 'teamId' | 'key'>, issuedAt: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({alg: 'ES256', kid: cfg.keyId})}.${part({iss: cfg.teamId, iat: issuedAt})}`;
  // JWS wants the raw r‖s pair, not Node's default DER.
  const signature = sign('sha256', Buffer.from(unsigned), {key: cfg.key, dsaEncoding: 'ieee-p1363'});
  return `${unsigned}.${signature.toString('base64url')}`;
}

export interface ApnsMessage {
  payload: Record<string, unknown>;
  collapseId?: string;
  ttlSec: number;
}

/** The web-push payload, reshaped for APNs. */
export function apnsMessage(p: {title: string; body: string; url: string; tag?: string; id?: string}): ApnsMessage {
  return {
    payload: {
      aps: {
        alert: {title: p.title, body: p.body},
        sound: 'default',
        ...(p.tag ? {'thread-id': p.tag} : {}),
      },
      url: p.url,
      ...(p.id ? {id: p.id} : {}),
    },
    // Like the web worker's `tag` + renotify: a repeat of the same event
    // replaces its card instead of stacking. Apple caps the id at 64 bytes.
    collapseId: p.tag ? p.tag.slice(0, 64) : undefined,
    ttlSec: 24 * 3600,
  };
}

export interface ApnsResponse {
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  /** Apple's reason string on errors (BadDeviceToken, Unregistered, …). */
  reason?: string;
}

/** Apple says this token will never work again: forget the device. */
export function isDeadToken(res: ApnsResponse): boolean {
  if (res.status === 410) return true;
  return res.status === 400 && (res.reason === 'BadDeviceToken' || res.reason === 'DeviceTokenNotForTopic');
}

export type ApnsTransport = (
  environment: ApnsEnvironment,
  headers: OutgoingHttpHeaders,
  body: string,
) => Promise<ApnsResponse>;

const HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

// Apple rejects a provider token older than an hour and throttles one
// refreshed more often than every 20 minutes.
const TOKEN_LIFETIME_SEC = 45 * 60;
const REQUEST_TIMEOUT_MS = 10_000;

export class ApnsClient {
  private jwt: {token: string; issuedAt: number} | null = null;
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  private readonly transport: ApnsTransport;

  constructor(
    private readonly cfg: ApnsConfig,
    transport?: ApnsTransport,
  ) {
    this.transport = transport ?? ((env, headers, body) => this.http2Request(env, headers, body));
  }

  async send(device: {token: string; environment: ApnsEnvironment}, message: ApnsMessage): Promise<ApnsResponse> {
    const headers: OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${device.token}`,
      authorization: `bearer ${this.currentToken()}`,
      'apns-topic': this.cfg.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + message.ttlSec),
      ...(message.collapseId ? {'apns-collapse-id': message.collapseId} : {}),
    };
    const res = await this.transport(device.environment, headers, JSON.stringify(message.payload));
    // A clock skew or a revoked key: sign a fresh token for the next send.
    if (res.status === 403 && res.reason === 'ExpiredProviderToken') this.jwt = null;
    return res;
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private currentToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (!this.jwt || now - this.jwt.issuedAt >= TOKEN_LIFETIME_SEC) {
      this.jwt = {token: providerToken(this.cfg, now), issuedAt: now};
    }
    return this.jwt.token;
  }

  /** One HTTP/2 connection per environment, reused until Apple closes it. */
  private session(env: ApnsEnvironment): ClientHttp2Session {
    const open = this.sessions.get(env);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(HOSTS[env]);
    const forget = () => {
      if (this.sessions.get(env) === session) this.sessions.delete(env);
    };
    // Without an 'error' listener a dropped connection would crash the process.
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    // An idle connection must not keep the process alive on shutdown.
    session.unref();
    this.sessions.set(env, session);
    return session;
  }

  private http2Request(env: ApnsEnvironment, headers: OutgoingHttpHeaders, body: string): Promise<ApnsResponse> {
    return new Promise((resolve) => {
      let status = 0;
      let data = '';
      let settled = false;
      const done = (res: ApnsResponse) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      let stream: ClientHttp2Stream;
      try {
        stream = this.session(env).request(headers);
      } catch (e) {
        done({status: 0, reason: (e as Error).message});
        return;
      }
      stream.setEncoding('utf8');
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        done({status: 0, reason: 'Timeout'});
      });
      stream.on('response', (h) => {
        status = Number(h[':status']) || 0;
      });
      stream.on('data', (chunk: string) => {
        data += chunk;
      });
      stream.on('end', () => {
        let reason: string | undefined;
        if (data) {
          try {
            reason = (JSON.parse(data) as {reason?: string}).reason;
          } catch {
            reason = data.slice(0, 200);
          }
        }
        done({status, reason});
      });
      stream.on('error', (e) => done({status, reason: e.message}));
      stream.on('close', () => done({status, reason: status ? undefined : 'Closed'}));
      stream.end(body);
    });
  }
}
