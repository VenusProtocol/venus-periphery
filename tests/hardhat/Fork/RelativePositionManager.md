# RelativePositionManager – Fork Test Plan

## 1. Purpose

This document defines the scope and objectives of fork-based integration tests
for the `RelativePositionManager` system. Unit tests already cover individual components

The goal of fork tests is to **extensively validate real position behavior
on mainnet / testnet state**, focusing on:

- Position lifecycle
- Capital utilization
- Withdrawals
- Scaling
- Dust handling
- Price sensitivity
- Liquidation scenarios

These tests ensure that the system behaves correctly under realistic
on-chain conditions.

---

## 2. Scope

Fork tests focus on:

- Real markets
- Real prices
- Real liquidity
- Real interest accrual
- Real liquidation thresholds

They do NOT re-test internal unit logic.

---

## 3. Account Deployment

### 3.1 Predictable Deployment

Tests must verify that:

- PositionAccount addresses are deterministic
- `getPositionAccountAddress` matches deployed address
- Same `(user, long, short)` always maps to the same account

### 3.2 No Duplicate Deployment

- Activating the same position twice must reuse the same account
- No new clone is created if one already exists
- Cycle ID increases correctly on re-activation

---

## 4. Utilization & Withdrawal (Core Focus)

### 4.1 Initial Position with Principal

Scenario:

1. Activate position with DSA principal
2. Open position using 3 tokens (DSA, Long, Short)
3. Validate:

   - Supplied principal
   - Borrowed amount
   - Long collateral
   - Utilization values

4. Verify `getUtilizationInfo` output

---

### 4.2 Progressive Scaling Using Utilization

Scenario:

1. Read available capital from utilization
2. Open position using full available capacity
3. Re-check utilization
4. Open again using remaining capacity
5. Final open must revert when limit is reached

Expected:

- Borrow cap enforced
- No over-leverage possible
- Proper revert reason

---

### 4.3 Withdrawal Validation

Scenario:

1. Open position
2. Read withdrawable amount
3. Withdraw within limit → success
4. Withdraw more than allowed → revert

Expected:

- Principal tracking remains consistent
- No under-collateralization after withdrawal

---

### 4.4 Withdrawal Under Price Changes (Long Asset)

Scenario:

1. Open leveraged position
2. Increase long asset price
3. Recalculate utilization
4. Withdrawable amount must increase
5. Withdraw increased amount

Expected:

- System reflects higher collateral value
- Withdrawal adapts correctly

---

### 4.5 Withdrawal Under Price Changes (Short Asset)

Scenario:

1. Open leveraged position
2. Increase short asset price
3. Recalculate utilization
4. Withdrawable amount must decrease
5. Withdrawal limited accordingly

Expected:

- Risk increases
- Withdrawal restricted

---

### 4.6 Stress Testing with Multiple Price Changes

Scenario:

- Apply repeated price changes:

  - Long ↑ / ↓
  - Short ↑ / ↓
  - DSA ↑ / ↓

- After each change:

  - Check utilization
  - Check max borrow
  - Check withdrawable amount

Expected:

- No inconsistent state
- No overflow/underflow
- No negative values

---

### 4.7 Near-Liquidation State

Scenario:

1. Manipulate prices until position is close to liquidation
2. Validate:

   - Utilization
   - Withdrawable amount ≈ 0
   - Borrow capacity ≈ 0

Expected:

- System prevents further risk
- Withdrawals restricted

---

## 5. Main Position Flow

---

### 5.1 Initial Open

Scenario:

1. Activate with principal
2. Open position
3. Validate:

   - Swap executed
   - Debt created
   - Collateral supplied
   - Events emitted

---

### 5.2 Position Scaling

Scenario:

1. Call `openPosition` again
2. Scale leverage
3. Validate:

   - Borrow increases
   - Long increases
   - Utilization updates

---

### 5.3 Swap & Dust Handling

Scenario:

1. Perform multiple opens and closes
2. Track dust balances
3. Validate:

   - Dust sent to user
   - No stuck tokens
   - No residual balances

Expected:

- All dust forwarded
- No trapped funds

---

## 6. Closing Scenarios

---

### 6.1 Partial Close

Scenario:

- Close part of position
- Validate:

  - Reduced debt
  - Reduced collateral
  - Updated utilization

---

### 6.2 Full Close (Neutral Price)

Scenario:

- Close when long ≈ short
- Validate full repayment
- Principal remains intact

---

### 6.3 Close With Profit

Scenario:

- Increase long price
- Close with profit
- Validate:

  - Debt fully repaid
  - Profit transferred
  - Position deactivated

---

### 6.4 Close With Loss

Scenario:

- Decrease long price
- Close with loss
- Validate:

  - Multi-step repayment
  - Remaining principal updated
  - Collateral transferred

---

### 6.5 Extreme Volatility Close

Scenario:

- Rapid price changes
- Large slippage
- Partial fills

Expected:

- No stuck positions
- No incorrect accounting

---

## 7. Liquidation Scenarios

---

### 7.1 Becoming Liquidatable

Scenario:

1. Open position
2. Increase short price / decrease long price
3. Reach liquidation threshold

Validate:

- Position marked liquidatable
- Withdrawable = 0
- Borrow limit exceeded

---

### 7.2 Post-Liquidation Recovery

Scenario:

1. External liquidator liquidates position
2. User attempts recovery

Validate:

- closePosition works
- closeWithLoss works
- No blocked funds
- State consistency

---

### 7.3 User-Initiated Close Near Liquidation

Scenario:

- User closes before liquidation

Validate:

- Partial exit allowed
- No forced liquidation

---

## 8. Multi-Cycle Behavior

Scenario:

1. Open → Close → Deactivate
2. Reactivate
3. Reuse same account
4. Repeat multiple times

Expected:

- No state leakage
- Cycle ID increments
- Principal isolated per cycle

---

## 9. Invariants (Fork-Level)

Fork tests must ensure:

- Principal ≥ 0
- Debt ≤ allowed maximum
- No trapped balances
- Only owner receives funds
- PositionAccount never hijacked

---

## 10. Observability

Each fork test should log:

- Prices
- Utilization
- Debt
- Collateral
- Principal
- Withdrawable

Used for debugging failures.

---

