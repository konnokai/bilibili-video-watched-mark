const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const SYNC_CODE_PATTERN = /^bvw_[A-Za-z0-9_-]{43}$/;
// D1 Free allows 50 queries per invocation. Authentication consumes one.
const MAX_PROGRESS_RECORDS = 49;
// A valid progress record is far below 512 bytes; this bounds buffered JSON.
const MAX_JSON_BYTES = MAX_PROGRESS_RECORDS * 512 + 1024;

type AccountRow = {
  id: string;
  bilibili_uid: string;
  created_at: number;
};

type ProgressRow = {
  bvid: string;
  page: number;
  position: number;
  duration: number;
  completed: number;
  updated_at: number;
};

type ProgressRecord = {
  bvid: string;
  page: number;
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: number;
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
}

function json(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders(), ...extraHeaders },
  });
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'content_type_must_be_json');
  }

  const declaredSize = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_JSON_BYTES) {
    throw new HttpError(413, 'request_too_large');
  }

  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_json');
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'request_too_large');
      }
      chunks.push(value);
    }

    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json');
  }
}

function generateSyncCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const value = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `bvw_${value}`;
}

async function hashSyncCode(syncCode: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(syncCode));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function authenticate(request: Request, env: Env) {
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  if (!match || !SYNC_CODE_PATTERN.test(match[1])) {
    throw new HttpError(401, 'invalid_sync_code');
  }

  const account = await env.DB.prepare(
    'SELECT id, bilibili_uid, created_at FROM accounts WHERE token_hash = ?1 LIMIT 1',
  ).bind(await hashSyncCode(match[1])).first<AccountRow>();
  if (!account) throw new HttpError(401, 'invalid_sync_code');
  return account;
}

function normalizeProgress(value: unknown): ProgressRecord {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'invalid_progress');
  const input = value as Record<string, unknown>;
  const page = input.page;
  const position = input.position;
  const duration = input.duration;
  const updatedAt = input.updatedAt;

  if (
    typeof input.bvid !== 'string' ||
    !BVID_PATTERN.test(input.bvid) ||
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    typeof position !== 'number' ||
    !Number.isFinite(position) ||
    position < 0 ||
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    typeof input.completed !== 'boolean' ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0
  ) {
    throw new HttpError(400, 'invalid_progress');
  }

  return {
    bvid: input.bvid,
    page,
    position: input.completed ? duration : Math.min(position, duration),
    duration,
    completed: input.completed,
    updatedAt: Math.min(updatedAt, Date.now()),
  };
}

function encodeProgressCursor(row: ProgressRow) {
  return btoa(JSON.stringify({
    updatedAt: row.updated_at,
    bvid: row.bvid,
    page: row.page,
  })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeProgressCursor(value: string | null) {
  if (!value) return null;

  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const cursor = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as Record<string, unknown>;
    if (
      typeof cursor.updatedAt !== 'number' ||
      !Number.isSafeInteger(cursor.updatedAt) ||
      cursor.updatedAt < 0 ||
      typeof cursor.bvid !== 'string' ||
      !BVID_PATTERN.test(cursor.bvid) ||
      typeof cursor.page !== 'number' ||
      !Number.isSafeInteger(cursor.page) ||
      cursor.page <= 0
    ) {
      throw new Error('invalid cursor');
    }
    return cursor as { updatedAt: number; bvid: string; page: number };
  } catch {
    throw new HttpError(400, 'invalid_cursor');
  }
}

async function createAccount(request: Request, env: Env) {
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.ACCOUNT_CREATION_RATE_LIMITER.limit({ key: clientIp });
  if (!success) throw new HttpError(429, 'rate_limited');

  const body = await readJson(request);
  const bilibiliUid = body && typeof body === 'object'
    ? (body as Record<string, unknown>).bilibiliUid
    : null;
  if (typeof bilibiliUid !== 'string' || !/^[1-9]\d{0,19}$/.test(bilibiliUid)) {
    throw new HttpError(400, 'invalid_bilibili_uid');
  }

  const id = crypto.randomUUID();
  const syncCode = generateSyncCode();
  const createdAt = Date.now();
  await env.DB.prepare(
    'INSERT INTO accounts (id, bilibili_uid, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)',
  ).bind(id, bilibiliUid, await hashSyncCode(syncCode), createdAt).run();

  return json({ accountId: id, bilibiliUid, syncCode, createdAt }, 201);
}

async function getAccount(request: Request, env: Env) {
  const account = await authenticate(request, env);
  return json({
    accountId: account.id,
    bilibiliUid: account.bilibili_uid,
    createdAt: account.created_at,
  });
}

async function getProgress(request: Request, env: Env) {
  const account = await authenticate(request, env);
  const cursor = decodeProgressCursor(new URL(request.url).searchParams.get('cursor'));
  const result = cursor
    ? await env.DB.prepare(
      `SELECT bvid, page, position, duration, completed, updated_at
         FROM progress
        WHERE account_id = ?1
          AND (
            updated_at > ?2 OR
            (updated_at = ?2 AND bvid > ?3) OR
            (updated_at = ?2 AND bvid = ?3 AND page > ?4)
          )
        ORDER BY updated_at ASC, bvid ASC, page ASC
        LIMIT ?5`,
    ).bind(
      account.id,
      cursor.updatedAt,
      cursor.bvid,
      cursor.page,
      MAX_PROGRESS_RECORDS + 1,
    ).all<ProgressRow>()
    : await env.DB.prepare(
      `SELECT bvid, page, position, duration, completed, updated_at
         FROM progress
        WHERE account_id = ?1
        ORDER BY updated_at ASC, bvid ASC, page ASC
        LIMIT ?2`,
    ).bind(account.id, MAX_PROGRESS_RECORDS + 1).all<ProgressRow>();

  const hasMore = result.results.length > MAX_PROGRESS_RECORDS;
  const rows = result.results.slice(0, MAX_PROGRESS_RECORDS);

  return json({
    records: rows.map((row) => ({
      bvid: row.bvid,
      page: row.page,
      position: row.position,
      duration: row.duration,
      completed: Boolean(row.completed),
      updatedAt: row.updated_at,
    })),
    nextCursor: hasMore ? encodeProgressCursor(rows.at(-1)!) : null,
  });
}

/**
 * Each statement atomically preserves the newest observation while allowing an
 * older completed record to promote the part to completed on every device.
 */
async function putProgress(request: Request, env: Env) {
  const account = await authenticate(request, env);
  const body = await readJson(request);
  const values = body && typeof body === 'object'
    ? (body as Record<string, unknown>).records
    : null;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_PROGRESS_RECORDS) {
    throw new HttpError(400, 'invalid_progress_batch');
  }

  const records = values.map(normalizeProgress);
  const sql = `
    INSERT INTO progress (
      account_id, bvid, page, position, duration, completed, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (account_id, bvid, page) DO UPDATE SET
      duration = CASE
        WHEN excluded.updated_at >= progress.updated_at THEN excluded.duration
        ELSE progress.duration
      END,
      position = CASE
        WHEN MAX(progress.completed, excluded.completed) = 1 THEN
          CASE
            WHEN excluded.updated_at >= progress.updated_at THEN excluded.duration
            ELSE progress.duration
          END
        WHEN excluded.updated_at >= progress.updated_at THEN
          MIN(excluded.position, excluded.duration)
        ELSE MIN(progress.position, progress.duration)
      END,
      completed = MAX(progress.completed, excluded.completed),
      updated_at = MAX(progress.updated_at, excluded.updated_at)
  `;

  await env.DB.batch(records.map((record) => env.DB.prepare(sql).bind(
    account.id,
    record.bvid,
    record.page,
    record.position,
    record.duration,
    record.completed ? 1 : 0,
    record.updatedAt,
  )));

  return json({ accepted: records.length });
}

async function deleteAccount(request: Request, env: Env) {
  const account = await authenticate(request, env);
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(account.id).run();
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Routes the complete v1 sync contract and converts expected failures to JSON. */
export async function handleRequest(request: Request, env: Env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok' });
    }
    if (request.method === 'POST' && url.pathname === '/v1/accounts') {
      return await createAccount(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/v1/account') {
      return await getAccount(request, env);
    }
    if (request.method === 'DELETE' && url.pathname === '/v1/account') {
      return await deleteAccount(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/v1/progress') {
      return await getProgress(request, env);
    }
    if (request.method === 'PUT' && url.pathname === '/v1/progress') {
      return await putProgress(request, env);
    }

    return json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);

    console.error(JSON.stringify({
      message: 'request_failed',
      method: request.method,
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ error: 'internal_error' }, 500);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
