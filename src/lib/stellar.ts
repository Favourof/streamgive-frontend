import {
  Account,
  Asset,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';

export const DONATION_VAULT_CONTRACT_ID =
  process.env.NEXT_PUBLIC_DONATION_VAULT_CONTRACT_ID ?? '';

export const NGO_REGISTRY_CONTRACT_ID = process.env.NEXT_PUBLIC_NGO_REGISTRY_CONTRACT_ID ?? '';

/**
 * The native XLM asset's Stellar Asset Contract address is deterministic
 * per network, not something deployed/looked up separately.
 *
 * @returns The native asset's contract address (StrKey `C...`) on whichever
 * network `NETWORK_PASSPHRASE` selects.
 */
export function getNativeAssetAddress(): string {
  return Asset.native().contractId(NETWORK_PASSPHRASE);
}

/** Circle's USDC issuer. Testnet by default; override for mainnet, where
 * Circle issues from a different account. */
export const USDC_ISSUER =
  process.env.NEXT_PUBLIC_USDC_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * USDC's Stellar Asset Contract address, derived the same deterministic
 * way as the native one rather than pinned as a literal — so pointing
 * NEXT_PUBLIC_USDC_ISSUER at mainnet's issuer is all it takes to move
 * networks. Circle's SAC is already deployed on testnet, so no separate
 * `stellar contract asset deploy` step is needed.
 *
 * @returns USDC's contract address (StrKey `C...`) on whichever network
 * `NETWORK_PASSPHRASE` selects, issued by `USDC_ISSUER`.
 */
export function getUsdcAssetAddress(): string {
  return new Asset('USDC', USDC_ISSUER).contractId(NETWORK_PASSPHRASE);
}

const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/**
 * Whether NETWORK_PASSPHRASE points at Stellar's mainnet, as opposed to
 * testnet or any other (e.g. local/futurenet) network. Donors are moving
 * real funds only when this is true — EnvironmentBanner and anything else
 * that needs to gate on "is this real money" should derive from this
 * rather than re-deriving its own passphrase comparison.
 */
export const IS_MAINNET = NETWORK_PASSPHRASE === PUBLIC_NETWORK_PASSPHRASE;

export const NETWORK_NAME = IS_MAINNET ? 'Mainnet' : 'Testnet';

/** Minimum base reserve kept to maintain an active Stellar account (1 XLM in stroops). */
export const NATIVE_ACCOUNT_RESERVE = 10_000_000n;

/** Estimated network fee buffer for Soroban contract invocations (0.1 XLM in stroops). */
export const NATIVE_FEE_ESTIMATE = 1_000_000n;

/** Total reserve plus estimated fee subtracted from native XLM balance. */
export const NATIVE_FEE_RESERVE = NATIVE_ACCOUNT_RESERVE + NATIVE_FEE_ESTIMATE;

// A fee/sequence-agnostic simulation, not a real submission, so a
// throwaway source account with sequence 0 is fine — the balance() call
// being simulated doesn't touch this account at all.
const SIMULATION_FEE = '100';
const SIMULATION_SOURCE_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Reads a SEP-41 token contract's `balance(id)` for `walletAddress`, via a
 * simulated (never submitted, never signed) contract call.
 *
 * Works for any token contract address — native XLM, USDC, or a
 * donor-supplied custom asset — since `balance` is part of every SAC and
 * every standard token contract's interface, unlike `getAssetBalance`,
 * which only accepts a classic `Asset` and so can't look up an arbitrary
 * custom contract address.
 *
 * @returns The raw i128 balance as a string (same units as everywhere else
 * in this app — see TOKEN_DECIMALS/formatAmount), or `null` if the
 * simulation fails (e.g. the address isn't a valid token contract).
 */
export async function getTokenBalance(
  tokenAddress: string,
  walletAddress: string,
): Promise<string | null> {
  try {
    const server = new rpc.Server(SOROBAN_RPC_URL);
    const account = new Account(SIMULATION_SOURCE_ACCOUNT, '0');
    const contract = new Contract(tokenAddress);

    const tx = new TransactionBuilder(account, {
      fee: SIMULATION_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('balance', nativeToScVal(walletAddress, { type: 'address' })))
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulated) || !simulated.result) {
      return null;
    }

    const balance = scValToNative(simulated.result.retval) as bigint;
    return balance.toString();
  } catch {
    return null;
  }
}

/**
 * Reads a SEP-41 token contract's `decimals()`, the same simulated-call
 * pattern as getTokenBalance above.
 *
 * Native XLM and USDC are both Stellar Asset Contracts, which always use 7
 * decimals, but a donor-supplied custom token contract can declare any
 * value here — this is how callers (CreateStreamForm) find the real one
 * instead of assuming TOKEN_DECIMALS (issue #204).
 *
 * @returns The token's decimals, or `null` if the simulation fails (e.g.
 * the address isn't a valid token contract).
 */
export async function getTokenDecimals(tokenAddress: string): Promise<number | null> {
  try {
    const server = new rpc.Server(SOROBAN_RPC_URL);
    const account = new Account(SIMULATION_SOURCE_ACCOUNT, '0');
    const contract = new Contract(tokenAddress);

    const tx = new TransactionBuilder(account, {
      fee: SIMULATION_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('decimals'))
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulated) || !simulated.result) {
      return null;
    }

    return Number(scValToNative(simulated.result.retval));
  } catch {
    return null;
  }
}

/**
 * Builds a stellar.expert URL for an account (wallet/NGO) or contract
 * (token) address, pointed at whichever network NETWORK_PASSPHRASE selects.
 *
 * @param kind - Whether `id` is a Stellar account (`G...`) or a contract
 * (`C...`).
 * @param id - The account or contract address to link to.
 * @returns A stellar.expert explorer URL for that address on the current
 * network.
 */
export function explorerUrl(kind: 'account' | 'contract', id: string): string {
  const network = NETWORK_NAME === 'Mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/${kind}/${id}`;
}
