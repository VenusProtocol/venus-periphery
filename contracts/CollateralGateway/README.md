# CollateralGateway

Turns an underlying balance into collateral in one call, on the Core pool and on Spoke Pools, and withdraws a vh position back to the wallet. One shared deployment per chain, with no proxy, no admin and no funds held between calls. The Core Comptroller is fixed at construction, so every Core function runs against it and a vh market has to be listed there.

## How It Works

A Liquidity Hub share token (vhUSDT, vhUSDC, vhU) is listed as its own Core market (vvhUSDT, ...), so a Hub position can double as Core collateral.

```
supplyFromWallet:      USDT ──► Hub.deposit ──► vhUSDT ──► vvhUSDT.mintBehalf(user)
                                                            └─► enterMarketForAccount(user, vvhUSDT)
supplyFromCollateral:  vUSDT ─► redeemBehalf ──► USDT ──► Hub.deposit ──► vhUSDT ──► vvhUSDT.mintBehalf(user)
                                                                     └─► enterMarketForAccount(user, vvhUSDT)
withdrawPosition:      transferFrom(user) [+ vvhUSDT.redeemBehalf(user)] ──► Hub.redeem(shares, user, gateway)
supplyAndEnterSpokeMarkets:  token ──► spokeMarket.mintBehalf(user) ──► enterMarketForAccount(user, market)
enterSpokeMarkets:           enterMarketForAccount(user, market)
```

`mintBehalf` credits the receipts to the caller, so they never sit in the gateway. Every supply into a Core vh market also enters that market for the caller through `Comptroller.enterMarketForAccount(account, vhMarket)`, so the position is collateral from the same call. Entering a market also makes the position seizable in a liquidation.

### Two migration paths

`supplyFromCollateral` removes the old collateral before the replacement exists, and the Comptroller evaluates that redeem as though the collateral were already gone. The gateway asks `getHypotheticalAccountLiquidity` first and branches:

|                | Condition                                 | Mechanism                                                                                                      |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Direct**     | removing the position leaves no shortfall | redeem, deposit, mint                                                                                          |
| **Flash loan** | it would leave a shortfall                | borrow the position's worth from Core, mint the replacement collateral, then redeem the old position and repay |

The flash loan passes `onBehalf = gateway`, so an unrepaid balance would become a borrow on the gateway rather than on the user. The loan is sized off `exchangeRateStored`, net of the Comptroller's redeem fee, then scaled down by the market's flash loan fee so the principal plus that fee still fits inside the redeem.

### Withdrawing

A vh position sits in two places, the wallet and the Core market. `withdrawPosition` takes one share amount and spends the wallet first, so a withdraw the wallet covers never touches Core. The Core leg redeems on the caller's behalf, so the Comptroller runs its liquidity check against the caller.

Receipts are derived from the shares by rounding up, then capped at the caller's balance. A mint rounds the receipt count down, so without the cap, redeeming a whole position asks for one receipt more than exists and the market underflows. Anything the Core leg cannot free shows up as a smaller payout, which the `minAssets` floor guards.

### Spoke Pools

Spoke markets are entered through `SpokeComptroller.enterMarketForAccount(account, vToken)`, which takes the same arguments in the same order as the Core `enterMarketForAccount`. Each market's Comptroller is read from the market itself, so one call may span pools. The gateway only ever passes `msg.sender` as the account. The amount supplied is measured as a balance delta, so a token that charges a transfer fee supplies only what arrived.

## Contract Structure

```
contracts/CollateralGateway/
├── CollateralGateway.sol      # Gateway contract
├── ICollateralGateway.sol     # Events, errors, external functions
├── IHub.sol                   # asset, deposit, redeem of a Liquidity Hub
└── README.md
```

It also uses `IComptroller`, `IILComptroller`, `IVToken` and `IFlashLoanReceiver` from `contracts/Interfaces/`.

## Core Functions

| Function                                                               | Starts from                  | Mechanism                                                         |
| ---------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `supplyFromWallet(hub, assets, vhMarket, minShares)`                   | underlying in the wallet     | deposit into the Hub, mint the vh market, enter it                |
| `supplyFromCollateral(vToken, vTokenAmount, hub, vhMarket, minShares)` | a Core position              | redeem, deposit, mint, enter; flash loan when borrowing           |
| `withdrawPosition(hub, vhMarket, shares, minAssets)`                   | Hub shares in wallet or Core | spend wallet shares, free the rest from the vh market, Hub redeem |
| `supplyAndEnterSpokeMarkets(vTokens, amounts)`                         | underlying in the wallet     | mint each Spoke market and enter it                               |
| `enterSpokeMarkets(vTokens)`                                           | Spoke receipts already held  | enter each Spoke market                                           |

## Prerequisites for Users

1. **supplyFromWallet:** `asset.approve(gateway, assets)`
2. **supplyFromCollateral:** `comptroller.updateDelegate(gateway, true)`
3. **withdrawPosition:** `hub.approve(gateway, shares)` for wallet shares, and `comptroller.updateDelegate(gateway, true)` when shares come out of the vh market
4. **supplyAndEnterSpokeMarkets:** `underlying.approve(gateway, amount)` for each market

The delegate grant is pool wide. It lets the gateway redeem and borrow against every Core position the user holds, and `updateDelegate(gateway, false)` revokes it.

## Governance Setup

| Needed for                             | Action                                                                                    | Target               |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------- |
| every Core supply                      | MarketFacet with `enterMarketForAccount(address,address)` cut into the Core Comptroller   | Core Comptroller     |
| every Core supply                      | `giveCallPermission(comptroller, "enterMarketForAccount(address,address)", gateway)`      | AccessControlManager |
| `supplyFromCollateral` while borrowing | `setWhiteListFlashLoanAccount(gateway, true)`                                             | Core Comptroller     |
| Spoke functions, per Spoke Comptroller | `giveCallPermission(spokeComptroller, "enterMarketForAccount(address,address)", gateway)` | AccessControlManager |

Until a grant exists, the functions that need it revert.

## Deployment

```bash
npx hardhat deploy --tags collateral-gateway --network bscmainnet
```

The constructor takes the Core Comptroller, read from the `Unitroller` deployment, which exists on `bscmainnet` and `bsctestnet`.

## Testing

Tests use Foundry. Run from the repo root after `git submodule update --init`:

```bash
# Unit tests
forge test --match-path "tests/foundry/unit/CollateralGateway_*"

# BSC mainnet fork tests at a pinned block, reading ARCHIVE_NODE_bscmainnet from .env
forge test --match-path "tests/foundry/fork/*"

# Transaction and gas counts per user journey
forge test --match-contract Fork_CollateralGatewayJourney -vv
```

Fork tests skip when `ARCHIVE_NODE_bscmainnet` is unset.

```
tests/foundry/
├── unit/
│   ├── CollateralGateway_Adversarial.t.sol  # Hostile hubs, markets and comptrollers
│   ├── CollateralGateway_Spoke.t.sol        # Spoke supply and enter
│   ├── CollateralGateway_Supply.t.sol       # supplyFromWallet and market entry
│   ├── CollateralGateway_Withdraw.t.sol     # Wallet and Core withdraw legs
│   └── mocks/MockERC20.sol
└── fork/
    ├── Fork_CollateralGateway.t.sol         # Live Hub_USDT, vvhUSDT and Core Comptroller
    ├── Fork_CollateralGatewayJourney.t.sol  # Gateway against the manual path
    └── fixtures/MarketFacet.deployed.hex    # MarketFacet with enterMarketForAccount
```

## License

BSD-3-Clause
