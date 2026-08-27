import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgressSummaries,
  mergePartProgress,
  mergeProgressCollections,
  parseVideoIdentity,
} from '../src/progress.js';

const record = (overrides = {}) => ({
  bvid: 'BV1FC8K6AEfh',
  page: 1,
  position: 30,
  duration: 100,
  completed: false,
  updatedAt: 1000,
  source: 'player',
  ...overrides,
});

test('parses BV id and positive part number', () => {
  assert.deepEqual(
    parseVideoIdentity('//www.bilibili.com/video/BV1FC8K6AEfh?p=3'),
    { bvid: 'BV1FC8K6AEfh', page: 3 },
  );
  assert.deepEqual(
    parseVideoIdentity('https://www.bilibili.com/video/BV1FC8K6AEfh?p=0'),
    { bvid: 'BV1FC8K6AEfh', page: 1 },
  );
  assert.equal(parseVideoIdentity('https://www.bilibili.com/bangumi/play/ep1'), null);
});

test('newer progress replaces older progress for the same part', () => {
  const merged = mergePartProgress(record(), record({ position: 70, updatedAt: 2000 }));
  assert.equal(merged.position, 70);
  assert.equal(merged.completed, false);
});

test('an older observation cannot replace newer progress', () => {
  const merged = mergePartProgress(
    record({ position: 70, updatedAt: 2000 }),
    record({ position: 20, updatedAt: 1000 }),
  );
  assert.equal(merged.position, 70);
  assert.equal(merged.updatedAt, 2000);
});

test('an older completed observation still promotes the part to completed', () => {
  const merged = mergePartProgress(
    record({ position: 70, updatedAt: 2000 }),
    record({ position: 100, completed: true, updatedAt: 1000 }),
  );
  assert.equal(merged.completed, true);
  assert.equal(merged.position, 100);
  assert.equal(merged.updatedAt, 2000);
});

test('completed state never falls back on the same part', () => {
  const completed = record({ position: 100, completed: true, updatedAt: 1000 });
  const replayed = record({ position: 20, updatedAt: 2000 });
  const merged = mergePartProgress(completed, replayed);

  assert.equal(merged.completed, true);
  assert.equal(merged.position, 100);
  assert.equal(merged.updatedAt, 2000);
});

test('different parts remain independent', () => {
  const merged = mergeProgressCollections(
    [record({ page: 1, completed: true, position: 100 })],
    [record({ page: 2, position: 25, updatedAt: 2000 })],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.page === 1).completed, true);
  assert.equal(merged.find((item) => item.page === 2).position, 25);
});

test('card summary uses the most recently watched part', () => {
  const summaries = buildProgressSummaries([
    record({ page: 1, completed: true, position: 100, updatedAt: 1000 }),
    record({ page: 2, position: 25, updatedAt: 2000 }),
  ]);

  assert.equal(summaries.BV1FC8K6AEfh.page, 2);
  assert.equal(summaries.BV1FC8K6AEfh.ratio, 0.25);
  assert.equal(summaries.BV1FC8K6AEfh.completed, false);
});
