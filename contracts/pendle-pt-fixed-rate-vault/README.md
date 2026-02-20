# PendlePTVaultAdapter

Universal adapter that wraps Pendle PT swap + Venus Core deposit/redeem into single transactions. Users deposit tokens (e.g. slisBNB, WBNB, or native BNB) and receive Venus vTokens — no direct Pendle interaction required.

> Full specification lives on [Notion](https://www.notion.so/) (internal). This README is a developer quick-reference.

## How It Works

```
DEPOSIT                                      WITHDRAW (before maturity)
───────                                      ─────────────────────────
User's token                                 User's vTokens
  │                                            │
  │ adapter.deposit()                          │ adapter.withdraw()
  ▼                                            ▼
Pendle Router                                Venus VToken
  swapExactTokenForPt()                        redeemBehalf() → PT to adapter
  tokenIn → SY → PT                           │
  │                                            ▼
  ▼                                          Pendle Router
Venus VToken                                   swapExactPtForToken()
  mintBehalf() → vTokens to user               PT → SY → tokenOut to user


REDEEM (at/after maturity)
──────────────────────────
User's vTokens
  │
  │ adapter.redeemAtMaturity()
  ▼
Venus VToken
  redeemBehalf() → PT to adapter
  │
  ▼
Pendle Router
  redeemPyToToken()
  PT → SY (1:1, no AMM) → tokenOut to user
```

## Contract Structure

```
contracts/pendle-pt-fixed-rate-vault/
├── PendlePTVaultAdapter.sol           # Main adapter contract
├── interfaces/
│   ├── IPendlePTVaultAdapter.sol      # Interface (structs, events, errors, signatures)
│   ├── IVenusVToken.sol               # Minimal VToken interface (mintBehalf, redeemBehalf)
│   └── IVenusComptroller.sol          # Minimal Comptroller interface (approvedDelegates)
└── README.md
```

## Key Design Decisions

- **Stateless** — no user accounting; all positions tracked by Venus vTokens
- **Any-token input** — accepts any token Pendle supports (not a fixed "underlying"); `TokenInput.tokenIn` is flexible
- **No separate native withdraw** — `withdraw`/`redeemAtMaturity` support native BNB output natively via Pendle Router (`tokenOut = address(0)`)
- **Immutables in constructor** — `PENDLE_ROUTER` and `WBNB` set via constructor, not `initialize()`
- **On-chain derivation** — `addMarket` derives PT/SY/YT/maturity from Pendle market and comptroller from vToken to prevent misconfiguration
- **Upgrade-safe** — `uint256[48] private __gap` storage gap

## Core Functions

| Function                                                            | When              | Mechanism                                            |
| ------------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| `deposit(pendleMarket, amount, minPtOut, guessPtOut, input, limit)` | Before maturity   | tokenIn → PT (AMM) → mintBehalf → vTokens to user    |
| `depositNative(pendleMarket, minPtOut, guessPtOut, input, limit)`   | Before maturity   | native BNB → PT (AMM) → mintBehalf → vTokens to user |
| `withdraw(pendleMarket, vTokenAmount, output, limit)`               | Before maturity   | redeemBehalf → PT → tokenOut (AMM) to user           |
| `redeemAtMaturity(pendleMarket, vTokenAmount, output)`              | At/after maturity | redeemBehalf → PT → tokenOut (1:1 via SY) to user    |

## Prerequisites for Users

1. **Deposit:** `tokenIn.approve(adapter, amount)` before calling `deposit`
2. **Withdraw / Redeem:** `comptroller.updateDelegate(adapter, true)` before calling `withdraw` or `redeemAtMaturity`

## Admin Functions

| Function                          | Purpose                          |
| --------------------------------- | -------------------------------- |
| `addMarket(pendleMarket, vToken)` | Register a new PT market         |
| `pause()` / `unpause()`           | Emergency pause all operations   |
| `sweepTokens(token, to, amount)`  | Recover stuck ERC-20 tokens      |
| `sweepNative(to, amount)`         | Recover stuck native BNB         |

## External Dependencies

| Protocol | Contract             | Address (BSC)                                |
| -------- | -------------------- | -------------------------------------------- |
| Pendle   | RouterV4             | `0x888888888889758F76e7103c6CbF23ABbF58F946` |
| Pendle   | Market / YT          | Per-market                                   |
| Venus    | VToken / Comptroller | Per-market                                   |

## Deployment

```bash
# 1. Deploy implementation
constructor(pendleRouter, wbnb)

# 2. Deploy TransparentUpgradeableProxy → implementation

# 3. Initialize proxy
initialize(owner)

# 4. Register markets
addMarket(pendleMarketAddress, vTokenAddress)

# 5. Transfer ownership to multisig/timelock
```

## Testing

Tests are forked BSC mainnet tests at a pinned block. Run from the repo root:

```bash
FORKED_NETWORK=bscmainnet npx hardhat test tests/hardhat/Fork/pendlePTVaultAdapter/index.spec.ts --network hardhat
```

Test structure:

```
tests/hardhat/Fork/pendlePTVaultAdapter/
├── index.spec.ts              # Single entry point (one fork context)
├── tests/
│   ├── admin.spec.ts          # Market management, pause, sweep
│   ├── deposit.spec.ts        # ERC-20 deposit, native deposit, error cases
│   ├── withdraw.spec.ts       # AMM sell path, 3 output token types
│   ├── redeemAtMaturity.spec.ts  # 1:1 redemption post-maturity
│   └── viewFunctions.spec.ts  # Config queries, delegation, immutables
└── utils/
    ├── constants.ts            # Addresses, block number
    ├── fixtures.ts             # base → deposited → maturedWithDeposits
    ├── helpers.ts              # Token acquisition, dummy structs, oracle fixes
    └── pendleApi.ts            # Pendle API client with retry/fallback
```

## License

BSD-3-Clause
