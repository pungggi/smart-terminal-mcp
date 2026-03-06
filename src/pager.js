export const DEFAULT_PAGE_SIZE = 100;

export function paginateOutput(text, { page = 0, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const normalizedPage = Math.max(0, page);
  const normalizedPageSize = Math.max(1, pageSize);
  const lines = splitLines(text);
  const start = normalizedPage * normalizedPageSize;
  const end = start + normalizedPageSize;
  const pageText = lines.slice(start, end).join('\n');

  return {
    pageText,
    totalLines: lines.length,
    hasNext: end < lines.length,
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}

function splitLines(text) {
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}