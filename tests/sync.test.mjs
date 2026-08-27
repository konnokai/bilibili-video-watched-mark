import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadProgress, uploadProgress } from '../src/sync.js';

const syncCode = `bvw_${'a'.repeat(43)}`;
const record = (index) => ({
  bvid: `BV${String(index).padStart(10, '0')}`,
  page: 1,
  position: index,
  duration: 100,
  completed: false,
  updatedAt: index,
  source: 'player',
});

test('sync client batches uploads and follows download cursors', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'PUT') return Response.json({ accepted: JSON.parse(init.body).records.length });
    if (url.endsWith('/v1/progress')) {
      return Response.json({ records: [record(1)], nextCursor: 'next-page' });
    }
    return Response.json({ records: [record(2)], nextCursor: null });
  };

  assert.equal(await uploadProgress(syncCode, Array.from({ length: 50 }, (_, index) => record(index)), fetchImpl), 50);
  assert.deepEqual((await downloadProgress(syncCode, fetchImpl)).map((item) => item.bvid), [record(1).bvid, record(2).bvid]);

  const uploads = calls.filter((call) => call.init.method === 'PUT');
  assert.deepEqual(uploads.map((call) => JSON.parse(call.init.body).records.length), [49, 1]);
  assert.ok(calls.every((call) => call.init.headers.Authorization === `Bearer ${syncCode}`));
});

test('retries a failed progress upload three times', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 3) throw new TypeError('net::ERR_CONNECTION_CLOSED');
    return Response.json({ accepted: 1 });
  };

  assert.equal(await uploadProgress(syncCode, [record(1)], fetchImpl), 1);
  assert.equal(calls, 4);
});
