import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDonationVaultClient } from '@/lib/donationVaultClient';

import { CreateStreamForm } from './CreateStreamForm';

const DONOR_ADDRESS = 'G' + 'D'.repeat(55);
const NGO_ADDRESS = 'G' + 'N'.repeat(55);
const NGO_ID = 'ngo-1';
const NGO_NAME = 'Test NGO';
const NATIVE_TOKEN_ADDRESS = 'CNATIVEFAKE';
// Matches CreateStreamForm's STELLAR_CONTRACT_RE (C + 55 base32 chars) so
// tests exercising "a valid custom token address" don't trip the same
// format validation a too-short placeholder like "CTOKENADDRESS" would.
const USDC_TOKEN_ADDRESS = 'CUSDCFAKE';
const CUSTOM_TOKEN_ADDRESS = 'C' + 'T'.repeat(55);

const mockSignTransaction = vi.fn();
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/components/wallet/WalletProvider', () => ({
  useWallet: () => ({
    address: DONOR_ADDRESS,
    connecting: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    signTransaction: mockSignTransaction,
    signMessage: vi.fn(),
  }),
}));

const mockGetTokenBalance = vi.fn();
const mockGetTokenDecimals = vi.fn();

vi.mock('@/lib/stellar', () => ({
  DONATION_VAULT_CONTRACT_ID: 'CVAULTFAKE',
  getNativeAssetAddress: () => NATIVE_TOKEN_ADDRESS,
  getUsdcAssetAddress: () => USDC_TOKEN_ADDRESS,
  getTokenBalance: (...args: unknown[]) => mockGetTokenBalance(...args),
  getTokenDecimals: (...args: unknown[]) => mockGetTokenDecimals(...args),
  NATIVE_ACCOUNT_RESERVE: 10_000_000n,
  NATIVE_FEE_ESTIMATE: 1_000_000n,
  NATIVE_FEE_RESERVE: 11_000_000n,
}));


const mockCreateStream = vi.fn();

vi.mock('@/lib/donationVaultClient', () => ({
  useDonationVaultClient: vi.fn(),
}));

describe('CreateStreamForm', () => {
  beforeEach(() => {
    mockCreateStream.mockReset();
    mockPush.mockReset();
    mockGetTokenBalance.mockReset();
    mockGetTokenBalance.mockResolvedValue('50000000000'); // 5,000 in raw units
    mockGetTokenDecimals.mockReset();
    mockGetTokenDecimals.mockResolvedValue(7);
    vi.mocked(useDonationVaultClient).mockReturnValue({
      client: { create_stream: mockCreateStream } as never,
      ready: true,
    });
  });

  it('disables submit and shows a loading label while the contract client is not ready', async () => {
    vi.mocked(useDonationVaultClient).mockReturnValue({ client: null, ready: false });

    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);
    await user.type(screen.getByPlaceholderText('100'), '100');

    expect(screen.getByRole('button', { name: /preparing contract/i })).toBeDisabled();
  });

  it('disables submit until a valid amount is entered', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    const submit = screen.getByRole('button', { name: /review & sign/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByPlaceholderText('100'), '100');

    expect(submit).not.toBeDisabled();
  });

  it('recalculates the displayed per-second rate as the amount and duration change', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    // 100 XLM over the default 1-month duration.
    await user.type(screen.getByPlaceholderText('100'), '100');
    expect(screen.getByText("That's roughly 0.0000385 per second.")).toBeInTheDocument();

    // Same amount, switched to the shorter 1-week duration — same deposit
    // spread over fewer seconds means a higher rate.
    await user.selectOptions(screen.getByLabelText(/stream over/i), '1 week');
    expect(screen.getByText("That's roughly 0.0001653 per second.")).toBeInTheDocument();

    // Doubling the amount at the same (1-week) duration doubles the rate.
    const amountInput = screen.getByPlaceholderText('100');
    await user.clear(amountInput);
    await user.type(amountInput, '200');
    expect(screen.getByText("That's roughly 0.0003306 per second.")).toBeInTheDocument();
  });

  it('requires a token address once "Custom asset" is selected', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    await user.type(screen.getByPlaceholderText('100'), '100');
    await user.click(screen.getByLabelText(/custom asset/i));

    const submit = screen.getByRole('button', { name: /review & sign/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/token contract address/i), CUSTOM_TOKEN_ADDRESS);
    // Entering a well-formed address kicks off a decimals() lookup (#204);
    // the button only re-enables once that settles.
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('flags an amount too small to produce a positive per-second rate', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    // 0.000001 * 10^7 = 10 raw units; 10 / (30 days in seconds) rounds to 0.
    // Not 0.0000001 (1 raw unit): jsdom's number input normalizes a value
    // below 1e-6 to scientific notation ("1e-7") once committed, which
    // parseAmount's plain-decimal regex doesn't parse -- the same behavior a
    // real browser shows for a number input below 1e-6, not a testing
    // artifact.
    await user.type(screen.getByPlaceholderText('100'), '0.000001');

    expect(screen.getByText(/too small to stream over this duration/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review & sign/i })).toBeDisabled();
  });

  it('surfaces the effective streamed total and leftover when the deposit does not divide evenly (#156)', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    // 100 XLM over the default 1-month (30-day) duration: 1_000_000_000n
    // stroops / 2_592_000 seconds = 385 stroops/sec (truncated), so only
    // 385 * 2_592_000 = 997_920_000 stroops (99.792 XLM) actually streams
    // out of the 1_000_000_000 stroop (100 XLM) deposit -- a leftover of
    // 2_080_000 stroops (0.208 XLM) that the contract has no way to return
    // except on cancel.
    await user.type(screen.getByPlaceholderText('100'), '100');

    expect(
      screen.getByText(/only 99\.792 of your deposit will stream out at this rate/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/the remaining 0\.208 stays in the stream/i)).toBeInTheDocument();
  });

  it('does not show a leftover warning when the deposit divides evenly by the duration', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    // 1 week = 604_800 seconds. A deposit of exactly 604_800 stroops gives a
    // rate of 1 stroop/sec with zero remainder.
    await user.selectOptions(screen.getByLabelText(/stream over/i), '604800');
    await user.type(screen.getByPlaceholderText('100'), '0.0604800');

    expect(screen.queryByText(/stays in the stream/i)).not.toBeInTheDocument();
  });

  it('re-enables submit after switching back to XLM (native) from a custom token', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    await user.type(screen.getByPlaceholderText('100'), '100');

    // Switch to custom and type an address so the button is enabled.
    await user.click(screen.getByLabelText(/custom asset/i));
    await user.type(screen.getByPlaceholderText(/token contract address/i), CUSTOM_TOKEN_ADDRESS);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled(),
    );

    // Switch back to native XLM — the custom address no longer matters.
    await user.click(screen.getByLabelText(/xlm \(native\)/i));
    expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled();
  });

  it('submits contract-shaped deposit/rate values and shows the resulting stream id', async () => {
    mockCreateStream.mockResolvedValue({
      signAndSend: vi.fn().mockResolvedValue({ result: 42n }),
    });

    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    await user.type(screen.getByPlaceholderText('100'), '100');
    await user.click(screen.getByRole('button', { name: /review & sign/i }));
    await user.click(await screen.findByRole('button', { name: /confirm & sign/i }));

    expect(await screen.findByText(/stream started/i)).toBeInTheDocument();
    expect(screen.getByText(/stream #42/i)).toBeInTheDocument();

    // 100 * 10^7 deposit, over the default 1-month duration (30 days).
    expect(mockCreateStream).toHaveBeenCalledWith({
      donor: DONOR_ADDRESS,
      ngo: NGO_ADDRESS,
      token: NATIVE_TOKEN_ADDRESS,
      deposit: 1_000_000_000n,
      rate: 1_000_000_000n / (30n * 24n * 60n * 60n),
    });
    // No ngoId was passed, so this stays on the inline success card rather
    // than navigating away — that's the embed widget's fallback behavior.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('navigates to the donate-success page when ngoId is provided', async () => {
    mockCreateStream.mockResolvedValue({
      signAndSend: vi.fn().mockResolvedValue({ result: 42n }),
    });

    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} ngoId={NGO_ID} />);

    await user.type(screen.getByPlaceholderText('100'), '100');
    await user.click(screen.getByRole('button', { name: /review & sign/i }));
    await user.click(await screen.findByRole('button', { name: /confirm & sign/i }));

    await screen.findByText(/stream started/i);
    expect(mockPush).toHaveBeenCalledWith(`/ngos/${NGO_ID}/donate/success?streamId=42`);
  });

  it('shows the estimated network fee once the transaction is assembled', async () => {
    mockCreateStream.mockResolvedValue({
      built: { fee: '1000000' },
      signAndSend: () => new Promise(() => {}),
    });

    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    await user.type(screen.getByPlaceholderText('100'), '100');
    await user.click(screen.getByRole('button', { name: /review & sign/i }));
    await user.click(await screen.findByRole('button', { name: /confirm & sign/i }));

    // 1 000 000 stroops = 0.1 XLM.
    expect(await screen.findByText(/estimated network fee: ≈ 0.1 xlm/i)).toBeInTheDocument();
  });

  describe('quick-amount presets', () => {
    it('fills the amount field when a preset is clicked', async () => {
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.click(screen.getByRole('button', { name: 'Set amount to 25' }));

      expect(screen.getByPlaceholderText('100')).toHaveValue(25);
    });

    it('still allows manual typing after a preset is clicked', async () => {
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.click(screen.getByRole('button', { name: 'Set amount to 25' }));
      expect(screen.getByPlaceholderText('100')).toHaveValue(25);

      const input = screen.getByPlaceholderText('100');
      await user.clear(input);
      await user.type(input, '42');

      expect(input).toHaveValue(42);
    });

    it('lets manual entry override a preset, and a later preset override manual entry', async () => {
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);
      const input = screen.getByPlaceholderText('100');

      await user.type(input, '7');
      expect(input).toHaveValue(7);

      await user.click(screen.getByRole('button', { name: 'Set amount to 100' }));
      expect(input).toHaveValue(100);
    });
  });

  describe('confirmation summary', () => {
    it('shows NGO, token, amount, rate, duration, and end date before signing', async () => {
      const user = userEvent.setup();
      render(
        <CreateStreamForm ngoAddress={NGO_ADDRESS} ngoId={NGO_ID} ngoName={NGO_NAME} />,
      );

      await user.type(screen.getByPlaceholderText('100'), '100');
      await user.click(screen.getByRole('button', { name: /review & sign/i }));

      const dialog = await screen.findByRole('dialog', { name: /confirm your stream/i });
      expect(dialog).toHaveTextContent(NGO_NAME);
      expect(dialog).toHaveTextContent('XLM (native)');
      expect(dialog).toHaveTextContent('100');
      expect(dialog).toHaveTextContent('/ second');
      expect(dialog).toHaveTextContent('1 month');

      // Not yet signed — the contract call is gated behind Confirm.
      expect(mockCreateStream).not.toHaveBeenCalled();
    });

    it('does not call the contract until Confirm & Sign is clicked', async () => {
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.type(screen.getByPlaceholderText('100'), '100');
      await user.click(screen.getByRole('button', { name: /review & sign/i }));

      await screen.findByRole('dialog');
      expect(mockCreateStream).not.toHaveBeenCalled();
    });

    it('returns to the form without calling the contract when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.type(screen.getByPlaceholderText('100'), '100');
      await user.click(screen.getByRole('button', { name: /review & sign/i }));
      await screen.findByRole('dialog');

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockCreateStream).not.toHaveBeenCalled();
      // The form is interactive again with the amount preserved.
      expect(screen.getByPlaceholderText('100')).toHaveValue(100);
      expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled();
    });

    it('calls the contract exactly once after confirming', async () => {
      mockCreateStream.mockResolvedValue({
        signAndSend: vi.fn().mockResolvedValue({ result: 42n }),
      });
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.type(screen.getByPlaceholderText('100'), '100');
      await user.click(screen.getByRole('button', { name: /review & sign/i }));
      await user.click(await screen.findByRole('button', { name: /confirm & sign/i }));

      await screen.findByText(/stream started/i);
      expect(mockCreateStream).toHaveBeenCalledTimes(1);
    });
  });

  it('fetches and displays the wallet balance for the selected token', async () => {
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    expect(await screen.findByText(/wallet balance: 5,000/i)).toBeInTheDocument();
    expect(mockGetTokenBalance).toHaveBeenCalledWith(NATIVE_TOKEN_ADDRESS, DONOR_ADDRESS);
  });

  it('re-fetches the balance when the selected token changes', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    await screen.findByText(/wallet balance: 5,000/i);
    mockGetTokenBalance.mockClear();
    mockGetTokenBalance.mockResolvedValue('20000000000'); // 2,000

    await user.click(screen.getByLabelText(/usdc/i));

    expect(await screen.findByText(/wallet balance: 2,000/i)).toBeInTheDocument();
    expect(mockGetTokenBalance).toHaveBeenCalledWith('CUSDCFAKE', DONOR_ADDRESS);
  });

  it('warns and disables submit when the entered amount exceeds the wallet balance', async () => {
    mockGetTokenBalance.mockResolvedValue('500000000'); // 50

    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    await screen.findByText(/wallet balance: 50/i);
    await user.type(screen.getByPlaceholderText('100'), '100');

    expect(
      screen.getByText(/exceeds your wallet balance — the transaction will fail/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review & sign/i })).toBeDisabled();
  });

  it('does not warn when the entered amount is within the wallet balance', async () => {
    const user = userEvent.setup();
    render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

    await screen.findByText(/wallet balance: 5,000/i);
    await user.type(screen.getByPlaceholderText('100'), '100');

    expect(screen.queryByText(/exceeds your wallet balance/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled();
  });

  describe('Max button and fee reserve (#237)', () => {
    it('sets the amount for native XLM leaving the reserve plus estimated fee', async () => {
      // Default mock balance is 5,000 XLM (50000000000 raw)
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await screen.findByText(/wallet balance: 5,000/i);
      const maxButton = screen.getByRole('button', { name: /set amount to max/i });
      await user.click(maxButton);

      const amountInput = screen.getByPlaceholderText('100') as HTMLInputElement;
      // 5000 XLM - 1.1 XLM reserve+fee = 4998.9 XLM
      expect(amountInput.value).toBe('4998.9');
      expect(screen.queryByText(/exceeds your wallet balance/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled();
    });

    it('warns when depositing the entire native XLM balance without leaving reserve and fee', async () => {
      mockGetTokenBalance.mockResolvedValue('1000000000'); // 100 XLM

      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await screen.findByText(/wallet balance: 100/i);
      // Typing 100 XLM exceeds the spendable balance of 98.9 XLM (100 - 1.1)
      await user.type(screen.getByPlaceholderText('100'), '100');

      expect(
        screen.getByText(/exceeds your wallet balance — the transaction will fail/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review & sign/i })).toBeDisabled();
    });

    it('sets the full balance for non-native tokens without subtracting reserve or fee', async () => {
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await screen.findByText(/wallet balance: 5,000/i);
      mockGetTokenBalance.mockClear();
      mockGetTokenBalance.mockResolvedValue('20000000000'); // 2,000 USDC

      await user.click(screen.getByLabelText(/usdc/i));
      await screen.findByText(/wallet balance: 2,000/i);

      const maxButton = screen.getByRole('button', { name: /set amount to max/i });
      await user.click(maxButton);

      const amountInput = screen.getByPlaceholderText('100') as HTMLInputElement;
      expect(amountInput.value).toBe('2000');
      expect(screen.queryByText(/exceeds your wallet balance/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled();
    });

    it('sets the full balance for custom tokens using token decimals', async () => {
      mockGetTokenDecimals.mockResolvedValue(6);
      mockGetTokenBalance.mockImplementation((token: string) => {
        if (token === NATIVE_TOKEN_ADDRESS) return Promise.resolve('50000000000');
        return Promise.resolve('50000000'); // 50 custom tokens (6 decimals)
      });

      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);


      await screen.findByText(/wallet balance: 5,000/i);
      await user.click(screen.getByLabelText(/custom asset/i));

      const contractInput = screen.getByPlaceholderText(/token contract address/i);
      await user.type(contractInput, 'C' + 'A'.repeat(55));

      await screen.findByText(/wallet balance: 50/i);

      const maxButton = screen.getByRole('button', { name: /set amount to max/i });
      await user.click(maxButton);

      const amountInput = screen.getByPlaceholderText('100') as HTMLInputElement;
      expect(amountInput.value).toBe('50');
      expect(screen.queryByText(/exceeds your wallet balance/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled();
    });
  });

  describe('amount validation message (#203)', () => {
    it('explains why more than 7 decimal places is rejected', async () => {
      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.type(screen.getByPlaceholderText('100'), '1.23456789');

      expect(screen.getByText('Use at most 7 decimal places.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review & sign/i })).toBeDisabled();
    });
  });

  describe('custom token decimals (#204)', () => {
    it("scales a custom token's deposit using its own decimals instead of assuming 7", async () => {
      mockGetTokenDecimals.mockResolvedValue(6);
      mockCreateStream.mockResolvedValue({
        signAndSend: vi.fn().mockResolvedValue({ result: 42n }),
      });

      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.click(screen.getByLabelText(/custom asset/i));
      await user.type(screen.getByPlaceholderText(/token contract address/i), CUSTOM_TOKEN_ADDRESS);
      await user.type(screen.getByPlaceholderText('100'), '100');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /review & sign/i })).not.toBeDisabled(),
      );

      await user.click(screen.getByRole('button', { name: /review & sign/i }));
      await user.click(await screen.findByRole('button', { name: /confirm & sign/i }));

      await screen.findByText(/stream started/i);

      // At the token's real 6 decimals, 100 is 100_000_000 raw units -- not
      // the 1_000_000_000 the hard-coded 7-decimal TOKEN_DECIMALS would have
      // produced, which is exactly the mis-scaled deposit issue #204 reports.
      expect(mockCreateStream).toHaveBeenCalledWith({
        donor: DONOR_ADDRESS,
        ngo: NGO_ADDRESS,
        token: CUSTOM_TOKEN_ADDRESS,
        deposit: 100_000_000n,
        rate: 100_000_000n / (30n * 24n * 60n * 60n),
      });
    });

    it("blocks submission with a clear warning when a custom token's decimals can't be read", async () => {
      mockGetTokenDecimals.mockResolvedValue(null);

      const user = userEvent.setup();
      render(<CreateStreamForm ngoAddress={NGO_ADDRESS} />);

      await user.click(screen.getByLabelText(/custom asset/i));
      await user.type(screen.getByPlaceholderText(/token contract address/i), CUSTOM_TOKEN_ADDRESS);
      await user.type(screen.getByPlaceholderText('100'), '100');

      expect(await screen.findByText(/couldn't read this token's decimals/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review & sign/i })).toBeDisabled();
      expect(mockCreateStream).not.toHaveBeenCalled();
    });
  });
});
