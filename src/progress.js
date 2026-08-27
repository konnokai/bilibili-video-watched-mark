const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

/**
 * Parses a regular Bilibili video URL into the stable BV id and part number.
 * Cards normally omit `p`, so part 1 is the canonical fallback.
 */
export function parseVideoIdentity(value, baseUrl = 'https://www.bilibili.com/') {
  if (typeof value !== 'string' || !value) return null;

  try {
    const url = new URL(value, baseUrl);
    const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/i);
    if (!match) return null;

    const bvid = `BV${match[1].slice(2)}`;
    if (!BVID_PATTERN.test(bvid)) return null;

    const requestedPage = Number.parseInt(url.searchParams.get('p') || '1', 10);
    return {
      bvid,
      page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    };
  } catch {
    return null;
  }
}

export function progressStorageKey(bvid, page) {
  return `progress:${bvid}:${page}`;
}

/**
 * Normalizes records at the storage and network boundary so malformed page or
 * API data cannot poison later merge decisions.
 */
export function normalizeProgressRecord(input) {
  if (!input || !BVID_PATTERN.test(input.bvid)) {
    throw new TypeError('Invalid Bilibili video id');
  }

  const page = Number(input.page);
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new TypeError('Invalid video part');
  }

  const rawDuration = Number(input.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const rawPosition = Number(input.position);
  const position = Number.isFinite(rawPosition) && rawPosition >= 0
    ? Math.min(rawPosition, duration || rawPosition)
    : 0;
  const completed = Boolean(input.completed);
  const rawUpdatedAt = Number(input.updatedAt);
  const updatedAt = Number.isFinite(rawUpdatedAt) && rawUpdatedAt >= 0
    ? Math.trunc(rawUpdatedAt)
    : Date.now();

  return {
    bvid: input.bvid,
    page,
    position: completed && duration ? duration : position,
    duration,
    completed,
    updatedAt,
    source: input.source === 'bilibili-history' ? 'bilibili-history' : 'player',
  };
}

/**
 * Merges updates for one part. Completion is monotonic, while ordinary
 * position data follows the newest observation.
 */
export function mergePartProgress(existingValue, incomingValue) {
  const incoming = normalizeProgressRecord(incomingValue);
  if (!existingValue) return incoming;

  const existing = normalizeProgressRecord(existingValue);
  if (existing.bvid !== incoming.bvid || existing.page !== incoming.page) {
    throw new TypeError('Cannot merge different video parts');
  }

  const newest = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  const older = newest === incoming ? existing : incoming;
  const completed = existing.completed || incoming.completed;
  const duration = newest.duration || older.duration;

  return {
    ...newest,
    duration,
    position: completed && duration
      ? duration
      : Math.min(newest.position, duration || newest.position),
    completed,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

/** Merges two record collections without collapsing different parts. */
export function mergeProgressCollections(first = [], second = []) {
  const records = new Map();

  for (const value of [...first, ...second]) {
    const record = normalizeProgressRecord(value);
    const key = progressStorageKey(record.bvid, record.page);
    records.set(key, mergePartProgress(records.get(key), record));
  }

  return [...records.values()];
}

export function progressRatio(value) {
  const record = normalizeProgressRecord(value);
  if (record.completed) return 1;
  if (!record.duration) return 0;
  return Math.max(0, Math.min(1, record.position / record.duration));
}

/** Selects the most recently watched part for each BV card. */
export function buildProgressSummaries(values = []) {
  const summaries = {};

  for (const value of values) {
    const record = normalizeProgressRecord(value);
    const current = summaries[record.bvid];
    if (
      !current ||
      record.updatedAt > current.updatedAt ||
      (record.updatedAt === current.updatedAt && record.page > current.page)
    ) {
      summaries[record.bvid] = {
        ...record,
        ratio: progressRatio(record),
      };
    }
  }

  return summaries;
}
