import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Stream } from '@/lib/api';

import NgoAdminPage from './page';

const NGO_ADDRESS = 'G' + 'N'.repeat(55);

const { lookupNgoByAddress, getStreams } = vi.hoisted(() => ({
  lookupNgoByAddress: vi.fn(),
  getStreams: vi.fn(),
}));

let currentAddress: string | null = NGO_ADDRESS;

vi.mock('@/components/wallet/WalletProvider', () => ({
  useWallet: () => ({ address: currentAddress }),
}));

vi.mock('@/components/toast/ToastProvider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({ lookupNgoByAddress, getStreams }));

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/ngos/DonateQrCode', () => ({ DonateQrCode: () => null }));
vi.mock('@/components/ngoAdmin/NgoAdminStreamList', () => ({
  NgoAdminStreamList: ({ streams }: { streams: Stream[] }) => (
    <div data-testid="ngo-admin-stream-list">Streams count: {streams.length}</div>
  ),
}));
vi.mock('@/components/ngoAdmin/WithdrawalHistory', () => ({ WithdrawalHistory: () => null }));
vi.mock('@/components/streams/StreamDetailsModal', () => ({ StreamDetailsModal: () => null }));

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: 's1',
    onChainId: '1',
    tokenAddress: 'CTOKEN',
    rate: '100',
    balance: '50000000',
    withdrawn: '20000000',
    status: 'ACTIVE',
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    donor: { address: 'GDONOR' },
    ngo: { id: 'ngo-1', name: 'Test NGO', ownerAddress: NGO_ADDRESS },
    ...overrides,
  };
}

describe('NgoAdminPage states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentAddress = NGO_ADDRESS;
    lookupNgoByAddress.mockResolvedValue({
      id: 'ngo-1',
      ownerAddress: NGO_ADDRESS,
      name: 'Test NGO',
      verified: true,
    });
    getStreams.mockResolvedValue([]);
  });

  it('renders connect wallet prompt when wallet is not connected', () => {
    currentAddress = null;
    render(<NgoAdminPage />);

    expect(
      screen.getByText("Connect your NGO's wallet to manage your streams."),
    ).toBeInTheDocument();
    expect(lookupNgoByAddress).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ngo-admin-stream-list')).not.toBeInTheDocument();
  });

  it('renders not-registered state when no NGO is found for the connected wallet', async () => {
    lookupNgoByAddress.mockResolvedValue(null);
    render(<NgoAdminPage />);

    expect(
      await screen.findByText(/this wallet isn't registered as an NGO yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /apply here/i })).toHaveAttribute('href', '/apply');
    expect(screen.queryByTestId('ngo-admin-stream-list')).not.toBeInTheDocument();
  });

  it('renders awaiting review state when NGO is registered but unverified', async () => {
    lookupNgoByAddress.mockResolvedValue({
      id: 'ngo-1',
      ownerAddress: NGO_ADDRESS,
      name: 'Hope Org',
      verified: false,
    });
    render(<NgoAdminPage />);

    expect(await screen.findByText('Your application is awaiting review.')).toBeInTheDocument();
    expect(
      screen.getByText(/We've received the application for Hope Org/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('ngo-admin-stream-list')).not.toBeInTheDocument();
  });

  it('renders verified view showing totals and the stream list', async () => {
    const streams = [
      makeStream({
        id: 's1',
        balance: '50000000', // 5 XLM
        withdrawn: '20000000', // 2 XLM
        status: 'ACTIVE',
      }),
      makeStream({
        id: 's2',
        balance: '30000000', // 3 XLM
        withdrawn: '10000000', // 1 XLM
        status: 'CANCELLED',
      }),
    ];
    getStreams.mockResolvedValue(streams);

    render(<NgoAdminPage />);

    expect(await screen.findByText('Managing streams for Test NGO.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Embed your donate widget' })).toBeInTheDocument();

    // Total withdrawn = 2 + 1 = 3
    expect(screen.getByText('Total withdrawn')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    // Remaining balance (ACTIVE streams only) = 5
    expect(screen.getByText('Remaining balance')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();

    // Active streams count = 1
    expect(screen.getByText('Active streams')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    // Stream list
    const streamList = screen.getByTestId('ngo-admin-stream-list');
    expect(streamList).toBeInTheDocument();
    expect(streamList).toHaveTextContent('Streams count: 2');
  });
});

