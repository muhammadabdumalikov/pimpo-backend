import {generateKeyPairSync, verify} from 'node:crypto';
import {
  ApnsClient,
  ApnsConfig,
  ApnsTransport,
  apnsMessage,
  isDeadToken,
  providerToken,
  readApnsConfig,
} from './apns';

const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const PEM = privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
const cfg: ApnsConfig = {keyId: 'KEY1234567', teamId: 'TEAM123456', key: privateKey, topic: 'uz.kpos.app'};

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;

describe('readApnsConfig', () => {
  it('is off unless key id, team id and key are all set', () => {
    expect(readApnsConfig({})).toBeNull();
    expect(readApnsConfig({APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T'})).toBeNull();
  });

  it('reads a one-line PEM with \\n escapes and defaults the topic', () => {
    const c = readApnsConfig({APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_PRIVATE_KEY: PEM.replace(/\n/g, '\\n')});
    expect(c?.topic).toBe('uz.kpos.app');
    expect(c?.key.asymmetricKeyType).toBe('ec');
  });

  it('throws on a key that is present but not a key', () => {
    expect(() => readApnsConfig({APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_PRIVATE_KEY: 'nope'})).toThrow();
  });
});

describe('providerToken', () => {
  it('is an ES256 JWT Apple can verify with the key', () => {
    const jwt = providerToken(cfg, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    expect(decode(h)).toEqual({alg: 'ES256', kid: 'KEY1234567'});
    expect(decode(c)).toEqual({iss: 'TEAM123456', iat: 1_700_000_000});
    const ok = verify('sha256', Buffer.from(`${h}.${c}`), {key: publicKey, dsaEncoding: 'ieee-p1363'}, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('apnsMessage', () => {
  it('mirrors the web payload: alert, deep link, id, tag as thread + collapse id', () => {
    const m = apnsMessage({title: 'Sotuv', body: '120 000', url: '/sales?sale=1', tag: 'checkout', id: 'n1'});
    expect(m.payload).toEqual({
      aps: {alert: {title: 'Sotuv', body: '120 000'}, sound: 'default', 'thread-id': 'checkout'},
      url: '/sales?sale=1',
      id: 'n1',
    });
    expect(m.collapseId).toBe('checkout');
  });

  it('caps the collapse id at 64 bytes and leaves it out without a tag', () => {
    expect(apnsMessage({title: 't', body: 'b', url: '/', tag: 'x'.repeat(80)}).collapseId).toHaveLength(64);
    expect(apnsMessage({title: 't', body: 'b', url: '/'}).collapseId).toBeUndefined();
  });
});

describe('isDeadToken', () => {
  it('drops only tokens Apple calls gone for good', () => {
    expect(isDeadToken({status: 410, reason: 'Unregistered'})).toBe(true);
    expect(isDeadToken({status: 400, reason: 'BadDeviceToken'})).toBe(true);
    expect(isDeadToken({status: 400, reason: 'DeviceTokenNotForTopic'})).toBe(true);
    expect(isDeadToken({status: 400, reason: 'PayloadTooLarge'})).toBe(false);
    expect(isDeadToken({status: 429, reason: 'TooManyRequests'})).toBe(false);
    expect(isDeadToken({status: 0, reason: 'Timeout'})).toBe(false);
  });
});

describe('ApnsClient.send', () => {
  it('posts to the device path with topic, type, auth and collapse id', async () => {
    const calls: Parameters<ApnsTransport>[] = [];
    const client = new ApnsClient(cfg, async (...args) => {
      calls.push(args);
      return {status: 200};
    });
    const res = await client.send({token: 'ab12', environment: 'sandbox'}, apnsMessage({title: 't', body: 'b', url: '/x', tag: 'test'}));
    expect(res.status).toBe(200);
    const [env, headers, body] = calls[0];
    expect(env).toBe('sandbox');
    expect(headers[':path']).toBe('/3/device/ab12');
    expect(headers['apns-topic']).toBe('uz.kpos.app');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-collapse-id']).toBe('test');
    expect(String(headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(body).url).toBe('/x');
  });

  it('reuses one provider token, and signs a new one after ExpiredProviderToken', async () => {
    const auths: string[] = [];
    let answer = {status: 200} as {status: number; reason?: string};
    const client = new ApnsClient(cfg, async (_env, headers) => {
      auths.push(String(headers.authorization));
      return answer;
    });
    const msg = apnsMessage({title: 't', body: 'b', url: '/'});
    await client.send({token: 'a', environment: 'production'}, msg);
    await client.send({token: 'b', environment: 'production'}, msg);
    expect(auths[0]).toBe(auths[1]);

    answer = {status: 403, reason: 'ExpiredProviderToken'};
    await client.send({token: 'c', environment: 'production'}, msg);
    answer = {status: 200};
    // Same second → same claims, so compare the reset itself rather than the string.
    expect((client as unknown as {jwt: unknown}).jwt).toBeNull();
    await client.send({token: 'd', environment: 'production'}, msg);
    expect((client as unknown as {jwt: unknown}).jwt).not.toBeNull();
  });
});
