'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ConnectWalletPrompt } from '@/components/common/ConnectWalletPrompt';
import { useWallet } from '@/components/wallet/WalletProvider';
import { useDonationVaultClient } from '@/lib/donationVaultClient';
import {
  describeAmountError,
  formatAmount,
  formatAmountInput,
  formatEstimatedFee,
  parseAmount,
  TOKEN_DECIMALS,
} from '@/lib/format';
import {
  DONATION_VAULT_CONTRACT_ID,
  getNativeAssetAddress,
  getTokenBalance,
  getTokenDecimals,
  getUsdcAssetAddress,
  NATIVE_FEE_RESERVE,
} from '@/lib/stellar';


const DURATIONS = [
  { label: '1 week', seconds: 7 * 24 * 60 * 60 },
  { label: '1 month', seconds: 30 * 24 * 60 * 60 },
  { label: '3 months', seconds: 90 * 24 * 60 * 60 },
  { label: '1 year', seconds: 365 * 24 * 60 * 60 },
];

// Quick-fill shortcuts for the "Total amount" field, in whichever token is
// currently selected (the field isn't pinned to a single currency, so
// these are unitless multipliers rather than e.g. "$5").
const PRESET_AMOUNTS = [5, 10, 25, 100];

type TokenChoice = 'native' | 'usdc' | 'custom';
type SubmitState = 'idle' | 'confirming' | 'signing' | 'success' | 'error';

const TOKEN_LABELS: Record<TokenChoice, string> = {
  native: 'XLM (native)',
  usdc: 'USDC',
  custom: 'Custom asset',
};

export function CreateStreamForm({
  ngoAddress,
  ngoId,
  ngoName,
}: {
  ngoAddress: string;
  ngoId?: string;
  ngoName?: string;
}) {
  const router = useRouter();
  const { address } = useWallet();
  const { client, ready } = useDonationVaultClient();

  const [tokenChoice, setTokenChoice] = useState<TokenChoice>('native');
  const [customToken, setCustomToken] = useState('');
  const [amount, setAmount] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(DURATIONS[1].seconds);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [estimatedFee, setEstimatedFee] = useState<string | null>(null);
  // Computed once, at the moment the confirmation step opens (inside the
  // handleSubmit event handler below), rather than derived from Date.now()
  // directly in render — reading the clock during render is an impure,
  // unstable read that can differ across re-renders of the same "confirm
  // this" snapshot.
  const [confirmationEndDate, setConfirmationEndDate] = useState<Date | null>(null);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  // Native XLM and USDC are both Stellar Asset Contracts, which always use 7
  // decimals, but a custom token can declare any value here — tokenDecimals
  // is that token's real scale once looked up (issue #204). null means
  // either "not a custom token" (no lookup needed, see the effect below) or
  // "lookup still pending/failed" for one that is; decimalsError/Loading
  // tell those two apart so the UI can block submission with a clear reason
  // rather than silently falling back to the wrong scale.
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(TOKEN_DECIMALS);
  const [decimalsLoading, setDecimalsLoading] = useState(false);
  const [decimalsError, setDecimalsError] = useState(false);

  const depositRaw = parseAmount(amount, tokenDecimals ?? TOKEN_DECIMALS);
  const isAmountValid = depositRaw !== null;
  const amountError = describeAmountError(amount, tokenDecimals ?? TOKEN_DECIMALS);

  // Integer division truncates: a deposit that doesn't divide evenly by the
  // duration leaves a remainder the per-second rate can't carry (issue
  // #156). The deposit itself is still submitted in full -- the contract
  // has no partial-deposit call -- so that remainder sits in the stream's
  // balance until cancel/top-up rather than ever actually streaming out.
  // Surfaced below so the donor sees the real effective total up front
  // instead of only discovering the dust on cancel.
  const rateRaw = depositRaw !== null ? depositRaw / BigInt(durationSeconds) : null;
  const isRateValid = rateRaw !== null && rateRaw > 0n;
  const effectiveStreamedRaw = rateRaw !== null ? rateRaw * BigInt(durationSeconds) : null;
  const leftoverRaw =
    depositRaw !== null && effectiveStreamedRaw !== null ? depositRaw - effectiveStreamedRaw : null;

  const STELLAR_CONTRACT_RE = /^C[A-Z2-7]{55}$/;
  const customTokenTrimmed = customToken.trim();
  const isCustomTokenFormatValid =
    tokenChoice !== 'custom' ||
    customTokenTrimmed.length === 0 ||
    STELLAR_CONTRACT_RE.test(customTokenTrimmed);
  const isTokenValid =
    tokenChoice !== 'custom' ||
    (customTokenTrimmed.length > 0 && STELLAR_CONTRACT_RE.test(customTokenTrimmed));

  // The token address actually being donated in, resolved the same way for
  // both the balance check below and the real create_stream call — null
  // while "Custom asset" is selected but its address isn't valid/complete
  // yet, since there is nothing to look a balance up for in that case.
  const selectedTokenAddress =
    tokenChoice === 'native'
      ? getNativeAssetAddress()
      : tokenChoice === 'usdc'
        ? getUsdcAssetAddress()
        : isCustomTokenFormatValid && customTokenTrimmed.length > 0
          ? customTokenTrimmed
          : null;

  // For native XLM, reserve 1 XLM base account reserve + 0.1 XLM estimated fee buffer
  // so donors cannot deposit funds needed to cover transaction fees and minimum reserve.
  const maxSpendableRaw =
    walletBalance === null
      ? null
      : tokenChoice === 'native'
        ? (BigInt(walletBalance) > NATIVE_FEE_RESERVE ? BigInt(walletBalance) - NATIVE_FEE_RESERVE : 0n)
        : BigInt(walletBalance);

  const insufficientBalance =
    maxSpendableRaw !== null && depositRaw !== null && depositRaw > maxSpendableRaw;


  const canSubmit =
    isAmountValid &&
    isRateValid &&
    isTokenValid &&
    !insufficientBalance &&
    !decimalsLoading &&
    !decimalsError &&
    submitState !== 'signing' &&
    submitState !== 'confirming' &&
    ready;

  // Looks up the real decimals for a custom token (issue #204) — native XLM
  // and USDC are both Stellar Asset Contracts, which are always 7, so only
  // the 'custom' path needs a network round trip. Runs on selectedTokenAddress
  // rather than customToken directly so a half-typed address (still failing
  // the StrKey format check) doesn't fire a lookup against a non-address.
  useEffect(() => {
    if (tokenChoice !== 'custom') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTokenDecimals(TOKEN_DECIMALS);
      setDecimalsLoading(false);
      setDecimalsError(false);
      return;
    }
    if (!selectedTokenAddress) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTokenDecimals(null);
      setDecimalsLoading(false);
      setDecimalsError(false);
      return;
    }

    let cancelled = false;
    setTokenDecimals(null);
    setDecimalsError(false);
    setDecimalsLoading(true);

    getTokenDecimals(selectedTokenAddress)
      .then((decimals) => {
        if (cancelled) return;
        if (decimals === null) {
          setDecimalsError(true);
        } else {
          setTokenDecimals(decimals);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDecimalsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tokenChoice, selectedTokenAddress]);

  useEffect(() => {
    if (!address || !selectedTokenAddress) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWalletBalance(null);
      return;
    }

    let cancelled = false;
    setBalanceLoading(true);
    setWalletBalance(null);

    getTokenBalance(selectedTokenAddress, address)
      .then((balance) => {
        if (!cancelled) {
          setWalletBalance(balance);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBalanceLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address, selectedTokenAddress]);

  const durationLabel =
    DURATIONS.find((d) => d.seconds === durationSeconds)?.label ?? `${durationSeconds}s`;

  function handleMaxClick(): void {
    if (maxSpendableRaw === null || maxSpendableRaw <= 0n) {
      return;
    }
    setAmount(formatAmountInput(maxSpendableRaw, tokenDecimals ?? TOKEN_DECIMALS));
  }

  // Intercepts the flow before the contract call: pressing "Review & Sign"

  // only opens the confirmation summary. The actual create_stream call
  // (previously fired straight from here) now lives in handleConfirm,
  // gated behind that extra step so a donor sees NGO/token/amount/rate/end
  // date before their wallet ever prompts for a signature.
  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setConfirmationEndDate(new Date(Date.now() + durationSeconds * 1000));
    setSubmitState('confirming');
  }

  function handleCancelConfirmation(): void {
    setSubmitState('idle');
  }

  async function handleConfirm(): Promise<void> {
    if (
      !address ||
      !client ||
      !selectedTokenAddress ||
      depositRaw === null ||
      rateRaw === null
    ) {
      return;
    }

    setSubmitState('signing');
    setErrorMessage(null);
    setEstimatedFee(null);

    try {
      const tx = await client.create_stream({
        donor: address,
        ngo: ngoAddress,
        token: selectedTokenAddress,
        deposit: depositRaw,
        rate: rateRaw,
      });

      // Client.create_stream already simulated the call to assemble this
      // transaction, so the fee estimate is ready here — shown before
      // signAndSend() goes on to trigger the wallet's signing prompt.
      setEstimatedFee(formatEstimatedFee(tx.built?.fee));

      const { result } = await tx.signAndSend();
      const newStreamId = String(result);

      setStreamId(newStreamId);
      setSubmitState('success');
      setAmount('');
      setDurationSeconds(DURATIONS[1].seconds);
      setTokenChoice('native');
      setCustomToken('');
      if (ngoId) {
        router.push(`/ngos/${ngoId}/donate/success?streamId=${newStreamId}`);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
      setSubmitState('error');
    } finally {
      setEstimatedFee(null);
    }
  }

  if (!DONATION_VAULT_CONTRACT_ID) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950">
        <p className="font-medium text-amber-800 dark:text-amber-300">Widget not configured</p>
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
          The donation contract address is missing. Set{' '}
          <code className="font-mono">NEXT_PUBLIC_DONATION_VAULT_CONTRACT_ID</code> in the
          deployment environment to enable donations.
        </p>
      </div>
    );
  }

  // We no longer return early here, as the user might want to create another stream.

  if (!address) {
    return <ConnectWalletPrompt message="Connect your wallet to start a stream." />;
  }

  return (
    <div className="space-y-8">
      {submitState === 'success' && streamId !== null && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-6 dark:border-green-900 dark:bg-green-950">
          <p className="font-medium text-green-800 dark:text-green-300">Stream started!</p>
          <p className="mt-1 text-sm text-green-700 dark:text-green-400">
            Stream #{streamId} is now active.
          </p>
        </div>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="max-w-md space-y-6">
      <fieldset>
        <legend className="text-sm font-medium">Token</legend>
        <div className="mt-2 flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="token"
              checked={tokenChoice === 'native'}
              onChange={() => setTokenChoice('native')}
            />
            XLM (native)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="token"
              checked={tokenChoice === 'usdc'}
              onChange={() => setTokenChoice('usdc')}
            />
            USDC
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="token"
              checked={tokenChoice === 'custom'}
              onChange={() => setTokenChoice('custom')}
            />
            Custom asset
          </label>
        </div>
        {tokenChoice === 'custom' && (
          <>
            <input
              type="text"
              value={customToken}
              onChange={(event) => setCustomToken(event.target.value)}
              placeholder="Token contract address (C...)"
              aria-invalid={!isCustomTokenFormatValid || undefined}
              aria-describedby={!isCustomTokenFormatValid ? 'custom-token-error' : undefined}
              className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:border-gray-700 dark:bg-gray-900 dark:focus-visible:ring-teal-400"
            />
            {!isCustomTokenFormatValid && (
              <p id="custom-token-error" className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                Must be a Stellar contract address starting with C followed by 55 uppercase letters
                or digits 2–7.
              </p>
            )}
            {isTokenValid && decimalsLoading && (
              <p role="status" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Checking this token&apos;s decimals…
              </p>
            )}
            {isTokenValid && decimalsError && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                Couldn&apos;t read this token&apos;s decimals — it may not be a valid token
                contract. Streaming it is blocked until this can be confirmed.
              </p>
            )}
          </>
        )}
      </fieldset>

      <label className="block">
        <span className="text-sm font-medium">Total amount</span>
        <input
          type="number"
          min="0"
          step="any"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="100"
          aria-invalid={amountError !== null || (isAmountValid && !isRateValid) || undefined}
          aria-describedby={
            amountError !== null
              ? 'amount-format-error'
              : isAmountValid && !isRateValid
                ? 'amount-error'
                : undefined
          }
          className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:border-gray-700 dark:bg-gray-900 dark:focus-visible:ring-teal-400"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESET_AMOUNTS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAmount(String(preset))}
              aria-label={`Set amount to ${preset}`}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:border-gray-700 dark:hover:bg-gray-800 dark:focus-visible:ring-teal-400"
            >
              {preset}
            </button>
          ))}
          <button
            type="button"
            onClick={handleMaxClick}
            disabled={maxSpendableRaw === null || maxSpendableRaw <= 0n}
            aria-label="Set amount to max"
            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800 dark:focus-visible:ring-teal-400"
          >
            Max
          </button>
        </div>

        {amountError !== null && (
          <p id="amount-format-error" className="mt-1 text-sm text-amber-600 dark:text-amber-400">
            {amountError}
          </p>
        )}
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {balanceLoading
            ? 'Checking wallet balance…'
            : walletBalance !== null
              ? `Wallet balance: ${formatAmount(walletBalance, tokenDecimals ?? TOKEN_DECIMALS)}`
              : null}
        </p>
        {insufficientBalance && (
          <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
            This exceeds your wallet balance — the transaction will fail.
          </p>
        )}
      </label>

      <label className="block">
        <span className="text-sm font-medium">Stream over</span>
        <select
          value={durationSeconds}
          onChange={(event) => setDurationSeconds(Number(event.target.value))}
          className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:border-gray-700 dark:bg-gray-900 dark:focus-visible:ring-teal-400"
        >
          {DURATIONS.map((d) => (
            <option key={d.seconds} value={d.seconds}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      {isAmountValid && rateRaw !== null && (
        <p id={!isRateValid ? 'amount-error' : undefined} className="text-sm text-gray-500 dark:text-gray-400">
          {isRateValid
            ? `That's roughly ${(Number(rateRaw) / 10 ** (tokenDecimals ?? TOKEN_DECIMALS)).toFixed(tokenDecimals ?? TOKEN_DECIMALS)} per second.`
            : 'That amount is too small to stream over this duration — try a shorter one.'}
        </p>
      )}

      {isRateValid && leftoverRaw !== null && leftoverRaw > 0n && effectiveStreamedRaw !== null && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Only {formatAmount(effectiveStreamedRaw.toString(), tokenDecimals ?? TOKEN_DECIMALS)} of
          your deposit will stream out at this rate; the remaining{' '}
          {formatAmount(leftoverRaw.toString(), tokenDecimals ?? TOKEN_DECIMALS)} stays in the
          stream&apos;s balance until you cancel or top up.
        </p>
      )}

      {submitState === 'signing' && estimatedFee && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Estimated network fee: {estimatedFee}
        </p>
      )}

      {submitState === 'error' && errorMessage && (
        <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-md bg-black px-6 py-3 text-sm font-medium text-white hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-gray-200 dark:focus-visible:ring-teal-400"
      >
        {submitState === 'signing'
          ? 'Confirm in your wallet…'
          : submitState === 'confirming'
            ? 'Reviewing…'
            : !ready
              ? 'Preparing contract…'
              : decimalsLoading
                ? 'Checking token…'
                : 'Review & Sign'}
      </button>

      {submitState === 'confirming' && confirmationEndDate && (
        <ConfirmDonationSummary
          ngoLabel={ngoName ?? ngoAddress}
          tokenLabel={TOKEN_LABELS[tokenChoice]}
          amount={amount}
          rateRaw={rateRaw}
          decimals={tokenDecimals ?? TOKEN_DECIMALS}
          durationLabel={durationLabel}
          effectiveEndDate={confirmationEndDate}
          onConfirm={() => void handleConfirm()}
          onCancel={handleCancelConfirmation}
        />
      )}
    </form>
    </div>
  );
}

/**
 * The confirmation step gating create_stream's actual contract call (see
 * CreateStreamForm.handleSubmit/handleConfirm). Structured the same way as
 * StreamDetailsModal (fixed overlay, role="dialog", Escape-to-close, focus
 * moved to the dialog and restored to the trigger on close) rather than
 * introducing a separate shared Modal primitive — there's exactly one other
 * modal in this codebase and it isn't itself built on a shared primitive,
 * so extracting one now would be speculative rather than justified by
 * actual reuse.
 */
function ConfirmDonationSummary({
  ngoLabel,
  tokenLabel,
  amount,
  rateRaw,
  decimals,
  durationLabel,
  effectiveEndDate,
  onConfirm,
  onCancel,
}: {
  ngoLabel: string;
  tokenLabel: string;
  amount: string;
  rateRaw: bigint | null;
  decimals: number;
  durationLabel: string;
  effectiveEndDate: Date;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const triggerElement = document.activeElement as HTMLElement | null;
    confirmButtonRef.current?.focus();

    return () => {
      if (triggerElement && typeof triggerElement.focus === 'function') {
        triggerElement.focus();
      }
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCancel();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const perSecondRate =
    rateRaw !== null ? `${(Number(rateRaw) / 10 ** decimals).toFixed(decimals)} / second` : '—';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-donation-heading"
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-donation-heading" className="text-lg font-semibold">
          Confirm your stream
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Review the details below before signing in your wallet.
        </p>

        <dl className="mt-6 space-y-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-gray-500 dark:text-gray-400">NGO</dt>
            <dd className="break-all text-right font-medium">{ngoLabel}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-gray-500 dark:text-gray-400">Token</dt>
            <dd className="font-medium">{tokenLabel}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-gray-500 dark:text-gray-400">Total amount</dt>
            <dd className="font-medium">{amount}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-gray-500 dark:text-gray-400">Rate</dt>
            <dd className="font-medium">{perSecondRate}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-gray-500 dark:text-gray-400">Duration</dt>
            <dd className="font-medium">{durationLabel}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-gray-500 dark:text-gray-400">Ends</dt>
            <dd className="font-medium">{effectiveEndDate.toLocaleString()}</dd>
          </div>
        </dl>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:border-gray-700 dark:hover:bg-gray-800 dark:focus-visible:ring-teal-400"
          >
            Cancel
          </button>
          <button
            type="button"
            ref={confirmButtonRef}
            onClick={onConfirm}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:bg-white dark:text-black dark:hover:bg-gray-200 dark:focus-visible:ring-teal-400"
          >
            Confirm &amp; Sign
          </button>
        </div>
      </div>
    </div>
  );
}
