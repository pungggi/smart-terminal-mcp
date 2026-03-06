import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAGE_SIZE, paginateOutput } from '../src/pager.js';

test('paginateOutput keeps the broader default page size for agent context', () => {
  const lines = Array.from({ length: DEFAULT_PAGE_SIZE + 1 }, (_, index) => `line ${index + 1}`).join('\n');
  const result = paginateOutput(lines);

  assert.equal(result.pageSize, 100);
  assert.equal(result.hasNext, true);
  assert.equal(result.pageText.split('\n').length, 100);
});

test('paginateOutput returns the first page and hasNext for remaining lines', () => {
  const result = paginateOutput('a\nb\nc\nd', { page: 0, pageSize: 2 });

  assert.deepEqual(result, {
    pageText: 'a\nb',
    totalLines: 4,
    hasNext: true,
    page: 0,
    pageSize: 2,
  });
});

test('paginateOutput returns the last page without hasNext', () => {
  const result = paginateOutput('a\nb\nc\nd', { page: 1, pageSize: 2 });

  assert.deepEqual(result, {
    pageText: 'c\nd',
    totalLines: 4,
    hasNext: false,
    page: 1,
    pageSize: 2,
  });
});

test('paginateOutput handles pages beyond the end', () => {
  const result = paginateOutput('a\nb', { page: 4, pageSize: 2 });

  assert.deepEqual(result, {
    pageText: '',
    totalLines: 2,
    hasNext: false,
    page: 4,
    pageSize: 2,
  });
});

test('paginateOutput handles empty output', () => {
  const result = paginateOutput('', { page: 0, pageSize: 5 });

  assert.deepEqual(result, {
    pageText: '',
    totalLines: 0,
    hasNext: false,
    page: 0,
    pageSize: 5,
  });
});