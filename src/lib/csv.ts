import type { Stream } from './api';
import { formatAmount, formatRemainingDuration } from './format';
import { getNativeAssetAddress } from './stellar';

const UTF8_BOM = '\uFEFF';

const CSV_HEADERS = [
  'Stream ID',
  'NGO',
  'Token',
  'Status',
  'Committed',
  'Withdrawn',
  'Rate per second',
  'Remaining',
  'Created',
];

// There's no symbol/name resolution for arbitrary tokens — only the native
// asset's contract address is derivable client-side.
function tokenLabel(tokenAddress: string): string {
  return tokenAddress === getNativeAssetAddress() ? 'XLM' : tokenAddress;
}

function escapeCsvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Builds a CSV of a donor's streams for the dashboard's "Export CSV"
 * button — one row per stream, amounts run through formatAmount. Prefixed with
 * a UTF-8 BOM so spreadsheet applications correctly decode non-ASCII characters. */
export function buildDonationHistoryCsv(streams: Stream[]): string {
  const rows = streams.map((stream) => {
    const committed = BigInt(stream.balance) + BigInt(stream.withdrawn);
    return [
      stream.onChainId,
      stream.ngo.name,
      tokenLabel(stream.tokenAddress),
      stream.status === 'ACTIVE' ? 'Active' : 'Cancelled',
      formatAmount(committed.toString()),
      formatAmount(stream.withdrawn),
      formatAmount(stream.rate),
      formatRemainingDuration(stream.balance, stream.rate),
      new Date(stream.createdAt).toLocaleDateString(),
    ].map(escapeCsvField);
  });

  return UTF8_BOM + [CSV_HEADERS, ...rows].map((row) => row.join(',')).join('\n');
}

