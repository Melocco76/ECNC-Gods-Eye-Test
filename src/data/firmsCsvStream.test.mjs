// Streaming FIRMS CSV ingestion: chunk-boundary safety, filtering, and caps.
// Pure fixtures — no network, no key.
//
// Run with: npm test   (node --test)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FirmsIngestError,
  acquisitionMsUtc,
  filterTrailing24h,
  parseFirmsCsv,
  streamFirmsCsv,
  trailingWindow,
} from './firmsCsv.js';

const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
const NOW = Date.UTC(2026, 8, 18, 12, 0);

const row = (lat, lon, date, time, extra = {}) => [
  lat, lon, extra.ti4 ?? '330.5', '0.39', '0.36', date, time,
  extra.satellite ?? 'N20', 'VIIRS', extra.confidence ?? 'n', '2.0NRT', '290.1', extra.frp ?? '1.5', 'D',
].join(',');

const ROWS = [
  row('38.99488', '-121.67046', '2026-09-18', '1006'),
  row('-33.5', '151.2', '2026-09-18', '45', { frp: '12.3', confidence: 'h' }), // unpadded acq_time
  row('10.1', '20.2', '2026-09-17', '1300', { confidence: 'l' }),
  row('55', '-3', '2026-09-10', '1200'), // older than 24 h → filtered
  row('61.5', '-149.9', '2026-09-18', '1130', { satellite: 'N21' }),
];
const CSV = `${HEADER}\n${ROWS.join('\n')}\n`;

async function* chunked(text, sizes) {
  const bytes = Buffer.from(text);
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = sizes[i % sizes.length];
    yield bytes.subarray(offset, offset + size);
    offset += size;
    i += 1;
  }
}

async function ingest(body, limits = {}) {
  const records = [];
  const summary = await streamFirmsCsv(body, { nowMs: NOW, onRecord: (r) => records.push(r), ...limits });
  return { records, summary };
}

test('streaming output matches the whole-text parser + 24 h filter for any chunk size', async () => {
  const expected = filterTrailing24h(parseFirmsCsv(CSV), NOW);
  assert.equal(expected.length, 4);
  for (const sizes of [[1], [2], [3, 5, 7], [13], [64], [1024], [CSV.length]]) {
    const { records, summary } = await ingest(chunked(CSV, sizes));
    assert.deepEqual(records, expected, `chunk sizes ${sizes}`);
    assert.equal(summary.kept, 4);
    assert.equal(summary.rows, 5);
  }
});

test('a header split across chunks is still recognised', async () => {
  const cut = HEADER.indexOf('acq_date') + 3; // mid-column-name
  const bytes = Buffer.from(CSV);
  async function* split() {
    yield bytes.subarray(0, cut);
    yield bytes.subarray(cut);
  }
  const { records } = await ingest(split());
  assert.equal(records.length, 4);
});

test('a row split across chunks (mid-field and mid-line-break) is reassembled', async () => {
  const bytes = Buffer.from(CSV);
  const firstRowEnd = CSV.indexOf('\n', HEADER.length + 1);
  async function* split() {
    yield bytes.subarray(0, firstRowEnd - 10);
    yield bytes.subarray(firstRowEnd - 10, firstRowEnd);
    yield bytes.subarray(firstRowEnd, firstRowEnd + 1); // just the newline
    yield bytes.subarray(firstRowEnd + 1);
  }
  const { records } = await ingest(split());
  assert.equal(records[0].lat, 38.99488);
  assert.equal(records.length, 4);
});

test('CRLF line endings, blank lines, a missing final newline and multi-byte text are handled', async () => {
  const text = `${HEADER}\r\n\r\n${ROWS[0]}\r\n${row('1', '2', '2026-09-18', '900', { satellite: 'Ñ✓' })}`;
  for (const size of [1, 5, 1000]) {
    const { records } = await ingest(chunked(text, [size]));
    assert.equal(records.length, 2);
    assert.equal(records[1].satellite, 'Ñ✓');
  }
});

test('malformed rows are skipped without failing the source', async () => {
  const text = [
    HEADER,
    'not,enough,columns',
    row('abc', '10', '2026-09-18', '1000'), // non-numeric latitude
    ROWS[0],
    row('5', '6', 'garbage', '1000'), // unparseable date → filtered
    '',
  ].join('\n');
  const { records, summary } = await ingest(chunked(text, [4]));
  assert.equal(records.length, 1);
  assert.equal(summary.rows, 4);
});

test('trailing-24 h filtering happens during ingestion (old and far-future rows dropped)', async () => {
  const text = [
    HEADER,
    row('1', '1', '2026-09-18', '1200'), // now → kept
    row('2', '2', '2026-09-17', '1200'), // exactly 24 h → kept (inclusive)
    row('3', '3', '2026-09-17', '1159'), // just outside → dropped
    row('4', '4', '2026-09-18', '1400'), // now + 2 h (slack edge) → kept
    row('5', '5', '2026-09-18', '1401'), // beyond slack → dropped
  ].join('\n');
  const { records } = await ingest(chunked(text, [9]));
  assert.deepEqual(records.map((r) => r.lat), [1, 2, 4]);
});

test('non-CSV upstream bodies (HTML / plain text / empty) fail with NOT_CSV', async () => {
  for (const body of ['<html><body>Invalid MAP_KEY</body></html>', 'Invalid MAP_KEY', '', '\n\n']) {
    await assert.rejects(
      ingest(chunked(body || ' ', [3])),
      (error) => error instanceof FirmsIngestError && error.code === 'NOT_CSV',
    );
  }
  // Header-only payload is valid and empty.
  const { records } = await ingest(chunked(`${HEADER}\n`, [5]));
  assert.deepEqual(records, []);
});

test('byte, row and record caps fail cleanly with distinct codes', async () => {
  const code = async (limits) => {
    try {
      await ingest(chunked(CSV, [16]), limits);
      return null;
    } catch (error) {
      assert.ok(error instanceof FirmsIngestError);
      assert.doesNotMatch(error.message, /https?:|key/i);
      return error.code;
    }
  };
  assert.equal(await code({ maxBytes: 100 }), 'BYTES_CAP');
  assert.equal(await code({ maxRows: 2 }), 'ROWS_CAP');
  assert.equal(await code({ maxRecords: 2 }), 'RECORDS_CAP');
  assert.equal(await code({ maxBytes: CSV.length, maxRows: 5, maxRecords: 4 }), null, 'exactly at the limits passes');
});

test('an oversized stream stops reading early instead of draining the body', async () => {
  let produced = 0;
  async function* endless() {
    yield Buffer.from(`${HEADER}\n`);
    for (;;) {
      produced += 1;
      yield Buffer.from(`${row('1', '1', '2026-09-18', '1000')}\n`);
    }
  }
  await assert.rejects(ingest(endless(), { maxRows: 50 }), (error) => error.code === 'ROWS_CAP');
  assert.ok(produced < 100, `stopped after ${produced} chunks`);
});

test('onRecord receives each record with its exact acquisition epoch ms', async () => {
  const seen = [];
  await streamFirmsCsv(chunked(CSV, [11]), {
    nowMs: NOW,
    onRecord: (record, acqMs) => seen.push([record.acqDate, record.acqTime, acqMs]),
  });
  assert.equal(seen.length, 4);
  for (const [date, time, acqMs] of seen) assert.equal(acqMs, acquisitionMsUtc(date, time));
});

test('trailingWindow is the single window definition (24 h back, 2 h forward, inclusive)', () => {
  const { oldest, newest } = trailingWindow(NOW);
  assert.equal(oldest, NOW - 24 * 3600_000);
  assert.equal(newest, NOW + 2 * 3600_000);
  const at = (ms) => ({ acqDate: new Date(ms).toISOString().slice(0, 10), acqTime: String(new Date(ms).getUTCHours() * 100 + new Date(ms).getUTCMinutes()) });
  const kept = filterTrailing24h([at(oldest), at(oldest - 60_000), at(newest), at(newest + 60_000)], NOW);
  assert.equal(kept.length, 2);
});
