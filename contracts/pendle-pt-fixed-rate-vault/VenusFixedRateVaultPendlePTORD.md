# Venus Fixed Rate Vault - Pendle PT Integration PRD

## 1. Executive Summary

Venus Fixed Rate Vault (Pendle PT Integration) is a product that wraps Pendle Protocol swap functionality into a simplified vault interface. It enables users to deposit underlying tokens (e.g., USDC, USDT) and automatically convert them to Principal Tokens (PT) to earn fixed-rate yields, without requiring direct interaction with the Pendle Protocol.

### Core Value Proposition

- **For Users:** One-click access to fixed-rate yields, eliminating the complexity of understanding PT tokens and manual Pendle operations
- **For Venus:** Enhanced yield product portfolio, increased PT market TVL, improved user conversion rates, and strengthened competitive positioning in DeFi fixed-income products

## 2. Problem Statement

### 2.1. Current Pain Points

Venus Core currently lists PT tokens as collateral assets, but the user experience presents significant friction:

- **Cognitive Barrier:** Users unfamiliar with Pendle cannot understand what PT tokens represent or how fixed yields work
- **Operational Complexity:** Even knowledgeable users must navigate to Pendle, execute swaps, then return to Venus to deposit PT tokens
- **Multi-step Process:** The current workflow involves at least 4-5 transactions across two protocols
- **Missed Opportunity:** High friction results in lower TVL capture and reduced market competitiveness versus protocols with integrated yield solutions

### 2.2. Target User Segments

| User Type | Current Experience | Pain Points |
| --- | --- | --- |
| Novice Users | Cannot understand PT tokens in Venus Core; abandon exploration | Lack of education, intimidating complexity |
| Intermediate Users | Aware of fixed yields but deterred by multi-protocol workflow | Time-consuming, error-prone process |
| Advanced Users | Can complete process but prefer streamlined solutions | Inefficiency, gas costs, UX friction |

## 3. Solution Overview

### 3.1. Product Concept

Create a vault contract that abstracts Pendle swap operations. Users interact with a simple deposit/withdraw interface while the vault handles all PT token conversion and deposit mechanics behind the scenes.

### 3.2. High-Level Architecture

**User Flow:**

- **Deposit:** User deposits BNB(for example) → VaultAdapter swaps to PT-slisBNBx(for example) via Pendle Router → PT tokens transferred to markets→ User receives vTokens
- **Withdraw (at maturity):** User redeems vTokens → VaultAdapter redeems PT to SY via Pendle Router → SY unwrapped/swapped to underlying → User receives underlying token
- **Early Exit:** User redeems vTokens → VaultAdapter sells PT for SY on Pendle Market → SY swapped to underlying at current market price → User receives underlying (subject to market conditions)

## 4. Functional Requirements

### 4.1. Core Features

#### 4.1.1. Deposit Function

| Attribute | Specification |
| --- | --- |
| Input | Underlying token (e.g., USDC, USDT, BNB) |
| Process | 1) Accept underlying token; 2) Swap to PT via Pendle Router; 3)Deposit PT-token on behavior of users 4)Mint vToken to user |
| Output | vToken representing user position |
| Slippage | User-configurable slippage tolerance (default 0.5%) |
| Minimum | Minimum deposit amount to ensure gas efficiency(optional) |

#### 4.1.2. Withdraw Function (Manual Redemption)

| Attribute | Specification |
| --- | --- |
| Trigger | User-initiated withdrawal request |
| At Maturity | PT redeemable 1:1 for the accounting asset (via SY), which may require unwrap/swap to underlying asset |
| Before Maturity | PT sold on Pendle AMM at current market price |
| Output | Underlying token returned to user |

#### 4.1.3. Early Exit Mechanism

Users may exit before PT maturity by selling PT tokens on the Pendle AMM. The exit price depends on current market conditions:

- If implied APY has decreased since deposit, user may receive more than expected
- If implied APY has increased since deposit, user may receive less than deposited amount
- Clear disclosure of market price

### 4.2. Vault Information Display

Each vault page must display:

| Data Point | Description |
| --- | --- |
| Fixed APY | Current fixed yield rate from Pendle market |
| Maturity Date | PT expiration date |
| Time to Maturity | Days/hours remaining until maturity |
| Underlying Asset | The base token (USDC, USDT, etc.) |
| Total Value Locked | Total liquidity in Pendle |
| Your Position | User deposit amount |
| Protocol Source | "Powered by Pendle" attribution |

## 5. Flowchart

### 5.1 Deposit

- See the fixed apy, underlying token in FE
- Entry amount to deposit
- See estimated output amount in FE
- approve and confirm deposit
- Vault contract receive calldata, interact with Pendle swap, swap underlying token to PT
- deposit pt into Venus core
- Venus core mint vToken
- Vault contract send vToken back to user

![image.png](attachment:ab647917-25aa-420e-8f5e-a869874e01b5:image.png)

### 5.2 withdraw

- **At maturity**
    - Display redeem at maturity
    - User input amount
    - get redeem calldata and info from API(e.g. estimated amount to redeem)
    - approve and confirm withdraw
    - Vault contract receive calldata, interact with Venus core to redeem vToken to PT
    - Vault contract interact with Pendle to redeem PT into underlying
    - Transfer underlying back to user
- **Before** **maturity**
    - Display withdraw
    - User input amount
    - get swap calldata and info from api(e.g. estimated amount to withdraw)
    - approve and confirm withdraw
    - Vault contract receive calldata, interact with Venus core to redeem vToken to PT
    - Vault contract interact with Pendle to swap PT into underlying
    - ransfer underlying back to user

![image.png](attachment:174e098c-4f7f-4be0-9b5b-bc7cd7e4773b:image.png)

## 6. Phase 1 Scope

### 6.1. Supported Markets (Examples)

Initial launch will support the following PT markets (to be finalized based on current Pendle listings):

| Underlying | PT Market | Maturity | Chain |
| --- | --- | --- | --- |
| USDC | PT-sUSDe-29May2026 | May 29, 2026 | BSC |
| BNB | PT-slisBNBx-29May2026 | May 29, 2026 | BSC |
- **Note:** Specific PT markets and maturity dates will be updated based on current Pendle market availability at launch.

## 7. User Experience Requirements

### 7.1. Vault Listing Page

Unified display with Ceffu Fixed Rate Vaults under same "Fixed Rate" category

- Clear differentiation label: "Pendle PT" vs "Ceffu" vault types
- **Sortable/filterable by:** APY, Maturity Date, Underlying Asset, Vault Type
- **Display key metrics:** Fixed APY, Maturity, TVL, Underlying Asset

### 7.2. Vault Detail Page

**Deposit Flow:**

- User selects underlying token amount
- **System displays:** expected PT amount, fixed APY, maturity date, projected return, projected APY
- User approves token (if needed) and confirms deposit
- Single transaction executes swap + deposit

**Withdraw Flow:**

- User selects amount to withdraw
- **System displays:** current value (market price if before maturity), expected amount of underlying token to receive
- User confirms withdrawal
- Underlying token returned to user wallet

### 7.3. Risk Disclosures

Required disclosures to be displayed prominently:

- Early exit may result in receiving less than deposited amount
- Fixed APY is locked at time of deposit; market rates may change
- Smart contract risks from both Venus and Pendle protocols
- Underlying protocol risks (e.g., stablecoin depeg for USDC/USDT vaults)

## 8. Fee Structure(optional)

Fee structure to be determined. Considerations include:

| Fee Type | Consideration |
| --- | --- |
| Entry/Exit Fee | One-time swap fee on deposits/withdrawals charged by Pendle |

[TBD: Final fee structure pending business decision]

## 9. Success Metrics

| Metric | Target | Measurement |
| --- | --- | --- |
| TVL Growth | $XX M within 3 months | On-chain data |
| User Conversion | XX% of visitors deposit | Analytics |
| Transaction Success | >99% success rate | Contract events |
| User Retention | XX% deposit in next vault | Wallet tracking |

## 10. Risk Assessment

| Risk | Severity | Mitigation | Contingency |
| --- | --- | --- | --- |
| Pendle contract risk | High | Use audited Pendle contracts only | Emergency pause function |
| Price manipulation | Medium | Multiple oracle sources | Slippage limits, TWAP |
| Liquidity shortage | Medium | Monitor Pendle liquidity | Slippage limits, TWAP |
| User confusion | Low | Clear UI/UX, education | Enhanced documentation |

## 11. Timeline

[To be defined based on development capacity and audit scheduling]

| Phase | Duration | Deliverables |
| --- | --- | --- |
| Design & Spec | X weeks | Final PRD, Technical Spec |
| Development | X weeks
Design
SC
BE
FE | Smart contracts, Frontend |
| Audit | X weeks | Audit report, fixes |
| Testnet | X weeks | Public testing, bug fixes |
| Mainnet Launch | - | Production deployment |

## 12. Open Questions

- **Fee Structure:** What fee model best balances user value and protocol sustainability?
    - no fee charged in this model in MVP phase
- **Chain Support:** Should Phase 1 include chains beyond BSC (Ethereum)?
    - Keep BSC first
- **PT Selection:** What criteria determine which PT markets to support?
    - depend on which PT is listed in core
- **Rollover Strategy:** Should vault automatically roll to next maturity or require manual action?
    - no, in this phase we just keep manually deposit, time matters, have 0→1 product first. leave iteration in next phase
- **Venus Core Integration:** How does this vault interact with existing PT collateral in Venus Core?
    - automatic deposit into Venus Core

### Appendix A: Glossary

| Term | Definition |
| --- | --- |
| PT (Principal Token) | Pendle token representing claim to the accounting asset at maturity (redeemable 1: 1 via SY, which can be unwrapped/swapped to underlying) |
| YT (Yield Token) | Pendle token representing claim to yield until maturity (not used in this vault) |
| Fixed APY | Locked yield rate determined at deposit time based on PT discount |
| Maturity | Date when PT can be redeemed 1: 1 for underlying asset |
| Implied APY | Market-derived yield rate based on current PT price |
| ERC-4626 | Tokenized vault standard for yield-bearing vaults |
| SY (Standardized Yield) | Pendle's accounting asset wrapper used in PT/YT tokenization and as the trading pair asset in Pendle Markets |