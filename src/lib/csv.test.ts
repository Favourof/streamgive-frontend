import { describe, expect, it } from 'vitest';

import type { Stream } from './api';
import { buildDonationHistoryCsv } from './csv';
import { getNativeAssetAddress } from './stellar';

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: 's1',
    onChainId: '1',
    tokenAddress: getNativeAssetAddress(),
    rate: '100',
    balance: '5000000',
    withdrawn: '2000000',
    status: 'ACTIVE',
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    donor: { address: 'GDONOR' },
    ngo: { id: 'ngo1', name: 'Test NGO', ownerAddress: 'GOWNER' },
    ...overrides,
  };
}

describe('buildDonationHistoryCsv', () => {
  it('emits a UTF-8 BOM, a header row and one row per stream with all details', () => {
    const csv = buildDonationHistoryCsv([makeStream()]);
    const [header, row] = csv.split('\n');

    expect(header).toBe(
      '\uFEFFStream ID,NGO,Token,Status,Committed,Withdrawn,Rate per second,Remaining,Created',
    );
    expect(row).toBe('1,Test NGO,XLM,Active,0.7,0.2,0.00001,~13 hours remaining,1/15/2026');
  });

  it('prefixes the output with a UTF-8 BOM so spreadsheet apps handle non-ASCII names', () => {
    const csv = buildDonationHistoryCsv([
      makeStream({ ngo: { id: 'ngo1', name: 'Médecins du Monde', ownerAddress: 'GOWNER' } }),
    ]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('Médecins du Monde');
  });

  it('labels non-native tokens by contract address and cancelled streams as Cancelled', () => {
    const csv = buildDonationHistoryCsv([
      makeStream({ tokenAddress: 'CUSDCCONTRACT', status: 'CANCELLED' }),
    ]);
    const [, row] = csv.split('\n');

    expect(row).toBe(
      '1,Test NGO,CUSDCCONTRACT,Cancelled,0.7,0.2,0.00001,~13 hours remaining,1/15/2026',
    );
  });

  it('quotes fields containing a comma', () => {
    const csv = buildDonationHistoryCsv([
      makeStream({ ngo: { id: 'ngo1', name: 'Hope, Inc.', ownerAddress: 'GOWNER' } }),
    ]);
    const [, row] = csv.split('\n');

    expect(row).toBe('1,"Hope, Inc.",XLM,Active,0.7,0.2,0.00001,~13 hours remaining,1/15/2026');
  });

  it('returns just the BOM and header for no streams', () => {
    expect(buildDonationHistoryCsv([])).toBe(
      '\uFEFFStream ID,NGO,Token,Status,Committed,Withdrawn,Rate per second,Remaining,Created',
    );
  });
});

