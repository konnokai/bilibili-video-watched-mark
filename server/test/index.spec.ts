import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

const api = (path: string, init?: RequestInit) => exports.default.fetch(
  new Request(`https://example.test${path}`, init),
);

async function createAccount(uid = '123456') {
  const response = await api('/v1/accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': crypto.randomUUID(),
    },
    body: JSON.stringify({ bilibiliUid: uid }),
  });
  expect(response.status).toBe(201);
  return response.json<{
    accountId: string;
    bilibiliUid: string;
    syncCode: string;
    createdAt: number;
  }>();
}

function authenticated(syncCode: string, method = 'GET', body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${syncCode}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM progress'),
    env.DB.prepare('DELETE FROM accounts'),
  ]);
});

describe('sync API', () => {
  it('creates an account, stores only the token hash, and authenticates it', async () => {
    const created = await createAccount();
    expect(created.syncCode).toMatch(/^bvw_[A-Za-z0-9_-]{43}$/);

    const stored = await env.DB.prepare(
      'SELECT token_hash FROM accounts WHERE id = ?1',
    ).bind(created.accountId).first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.token_hash).not.toBe(created.syncCode);

    const account = await api('/v1/account', authenticated(created.syncCode));
    expect(account.status).toBe(200);
    await expect(account.json()).resolves.toMatchObject({
      accountId: created.accountId,
      bilibiliUid: '123456',
    });

    const unauthorized = await api('/v1/account', authenticated('bvw_invalid'));
    expect(unauthorized.status).toBe(401);
  });

  it('keeps account progress isolated', async () => {
    const first = await createAccount('111');
    const second = await createAccount('222');
    const record = {
      bvid: 'BV1FC8K6AEfh',
      page: 1,
      position: 30,
      duration: 100,
      completed: false,
      updatedAt: 1000,
    };

    expect((await api('/v1/progress', authenticated(first.syncCode, 'PUT', {
      records: [record],
    }))).status).toBe(200);

    const firstRecords = await api('/v1/progress', authenticated(first.syncCode));
    await expect(firstRecords.json()).resolves.toEqual({ records: [record], nextCursor: null });
    const secondRecords = await api('/v1/progress', authenticated(second.syncCode));
    await expect(secondRecords.json()).resolves.toEqual({ records: [], nextCursor: null });
  });

  it('preserves newer progress and permanently promotes completion', async () => {
    const account = await createAccount();
    const write = (record: Record<string, unknown>) => api(
      '/v1/progress',
      authenticated(account.syncCode, 'PUT', { records: [record] }),
    );
    const base = {
      bvid: 'BV1FC8K6AEfh',
      page: 2,
      duration: 100,
    };

    expect((await write({ ...base, position: 70, completed: false, updatedAt: 2000 })).status).toBe(200);
    expect((await write({ ...base, position: 20, completed: false, updatedAt: 1000 })).status).toBe(200);
    expect((await write({ ...base, position: 100, completed: true, updatedAt: 1500 })).status).toBe(200);
    expect((await write({ ...base, position: 10, completed: false, updatedAt: 3000 })).status).toBe(200);

    const response = await api('/v1/progress', authenticated(account.syncCode));
    await expect(response.json()).resolves.toEqual({
      records: [{
        ...base,
        position: 100,
        completed: true,
        updatedAt: 3000,
      }],
      nextCursor: null,
    });
  });

  it('paginates progress with a stable cursor', async () => {
    const account = await createAccount();
    const records = Array.from({ length: 49 }, (_, index) => ({
      bvid: `BV${String(index).padStart(10, '0')}`,
      page: 1,
      position: index,
      duration: 100,
      completed: false,
      updatedAt: index,
    }));
    expect((await api('/v1/progress', authenticated(account.syncCode, 'PUT', {
      records,
    }))).status).toBe(200);
    expect((await api('/v1/progress', authenticated(account.syncCode, 'PUT', {
      records: [{
        bvid: 'BV9999999999',
        page: 1,
        position: 50,
        duration: 100,
        completed: false,
        updatedAt: 50,
      }],
    }))).status).toBe(200);

    const first = await (await api('/v1/progress', authenticated(account.syncCode))).json<{
      records: unknown[];
      nextCursor: string;
    }>();
    expect(first.records).toHaveLength(49);
    expect(first.nextCursor).toBeTruthy();

    const second = await api(
      `/v1/progress?cursor=${encodeURIComponent(first.nextCursor)}`,
      authenticated(account.syncCode),
    );
    await expect(second.json()).resolves.toMatchObject({
      records: [{ bvid: 'BV9999999999' }],
      nextCursor: null,
    });
  });

  it('rejects oversized bodies and strict-invalid numeric types', async () => {
    const account = await createAccount();
    const wrongType = await api('/v1/progress', authenticated(account.syncCode, 'PUT', {
      records: [{
        bvid: 'BV1FC8K6AEfh',
        page: '1',
        position: 1,
        duration: 10,
        completed: false,
        updatedAt: 1,
      }],
    }));
    expect(wrongType.status).toBe(400);

    const oversized = await api('/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bilibiliUid: '123', unused: 'x'.repeat(30000) }),
    });
    expect(oversized.status).toBe(413);

    expect((await api('/v1/progress', authenticated(account.syncCode, 'PUT', {
      records: [{
        bvid: 'BV1FC8K6AEfh',
        page: 1,
        position: 10,
        duration: 100,
        completed: false,
        updatedAt: Number.MAX_SAFE_INTEGER,
      }],
    }))).status).toBe(200);
    expect((await api('/v1/progress', authenticated(account.syncCode, 'PUT', {
      records: [{
        bvid: 'BV1FC8K6AEfh',
        page: 1,
        position: 80,
        duration: 100,
        completed: false,
        updatedAt: Date.now(),
      }],
    }))).status).toBe(200);
    const records = await (await api('/v1/progress', authenticated(account.syncCode))).json<{
      records: Array<{ position: number; updatedAt: number }>;
    }>();
    expect(records.records[0].position).toBe(80);
    expect(records.records[0].updatedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('validates input and deletes account data', async () => {
    const account = await createAccount();
    const invalid = await api('/v1/progress', authenticated(account.syncCode, 'PUT', {
      records: [{
        bvid: 'not-a-bvid',
        page: 1,
        position: 1,
        duration: 10,
        completed: false,
        updatedAt: 1,
      }],
    }));
    expect(invalid.status).toBe(400);

    const valid = await api('/v1/progress', authenticated(account.syncCode, 'PUT', {
      records: [{
        bvid: 'BV1FC8K6AEfh',
        page: 1,
        position: 5,
        duration: 10,
        completed: false,
        updatedAt: 1,
      }],
    }));
    expect(valid.status).toBe(200);

    const deleted = await api('/v1/account', authenticated(account.syncCode, 'DELETE'));
    expect(deleted.status).toBe(204);
    expect((await api('/v1/account', authenticated(account.syncCode))).status).toBe(401);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM progress').first<number>('count')).toBe(0);
  });

  it('answers health checks and CORS preflight', async () => {
    const health = await api('/health');
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });

    const preflight = await api('/v1/progress', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rate limits account creation per client IP', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': crypto.randomUUID(),
    };
    const create = () => api('/v1/accounts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ bilibiliUid: '123456' }),
    });

    expect((await create()).status).toBe(201);
    const limited = await create();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: 'rate_limited' });
  });
});
