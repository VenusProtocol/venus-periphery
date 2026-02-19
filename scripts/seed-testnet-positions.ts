/**
 * Testnet Position Seeding Script — RelativePositionManager
 *
 * Creates 10 different position lifecycle states across 10 deterministic test-user wallets
 * so the backend can index all relevant events and the UI can display various position states.
 *
 * Scenarios A–G use the standard market layout (vTHE long, vSOL short, vFDUSD DSA).
 * Scenario H tests the same-market case where longVToken == dsaVToken (vFDUSD long, vSOL short).
 * Scenario I tests the same-market case where dsaVToken == shortVToken (vSOL long, vFDUSD short)
 * and exercises a loss close where the DSA (FDUSD) is used directly to repay the FDUSD debt (no swap).
 *
 * All swaps use manipulated calldata: SwapHelper is pre-funded with the output token and
 * a signed multicall transfers those tokens to the recipient instead of executing a real DEX swap.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY       — funds test users, submits txs
 *   BACKEND_SIGNER_PRIVATE_KEY — must belong to SwapHelper.backendSigner() address
 *   ARCHIVE_NODE_bsctestnet    — RPC endpoint
 *
 * Run:
 *   npx hardhat run scripts/seed-testnet-positions.ts --network bsctestnet
 */
import "@nomiclabs/hardhat-ethers";
import { BigNumber, Wallet, ethers } from "ethers";
import { parseEther } from "ethers/lib/utils";
// registers hre.ethers type augmentation
import hre from "hardhat";

// ---------------------------------------------------------------------------
// Deployed contract addresses (BSC testnet, ChainID 97)
// ---------------------------------------------------------------------------
const RPM_ADDRESS = "0xcB84425698B9426b5Edd9Ed25eA0116aA0c2Ce7F";
const LEVERAGE_MANAGER_ADDRESS = "0xE852204A757A3Ee9Dfc5d608b7038f962f393706";
const SWAP_HELPER_ADDRESS = "0xf7Cfd0eDfAC7AA473813559b372297332EdEbB8B";

// Token addresses (underlying ERC-20)
const USDT_ADDRESS = "0xcF27439fA231af9931ee40c4f27Bb77B83826F3C"; // FDUSD (18 decimals)
const CAKE_ADDRESS = "0x952653d23cB9bef19E442D2BF8fBc8843A968052"; // THE  (18 decimals)
const SOL_ADDRESS = "0xC337Dd0390FdFD0Ee5D2b682E425986EDD7b59da"; // (18 decimals)

// vToken addresses (Core Pool)
const vUSDT_ADDRESS = "0xF06e662a00796c122AaAE935EC4F0Be3F74f5636"; // DSA // FDUSD
const vCAKE_ADDRESS = "0x39A239F5117BFaC7a1b0b3A517c454113323451d"; // long // THE
const vSOL_ADDRESS = "0xbd9EB061444665Df7282Ec0888b72D60aC41Eb8C"; // short

// DSA index in the RelativePositionManager (1 = vFDUSD, configured at deploy time)
const DSA_INDEX = 1;

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const CHAIN_ID = 97;

// ---------------------------------------------------------------------------
// Seed amounts
// ---------------------------------------------------------------------------
const PRINCIPAL_USDT = parseEther("100"); // 100 FDUSD principal per user (18 decimals mock token)
const SHORT_AMOUNT = parseEther("0.1"); // borrow 0.1 SOL per open (standard scenarios A-G)
const LONG_AMOUNT = parseEther("1"); // 1 THE "received" from swap  (standard scenarios)
const GAS_BUDGET = parseEther("0.02"); // BNB sent to each test user for gas
const LEVERAGE = parseEther("1.5"); // 1.5× effective leverage

// Amounts specific to the same-market scenarios
// Scenario H: long == DSA (longVToken = vFDUSD, shortVToken = vSOL, DSA = vFDUSD)
//   borrow SOL, receive FDUSD as long
const LONG_AMOUNT_USDT = parseEther("0.01"); // FDUSD "received" in open swap (18 dec mock)

// Scenario I: DSA == short (longVToken = vSOL, shortVToken = vFDUSD, DSA = vFDUSD)
//   borrow FDUSD, receive SOL as long; close with loss where DSA (FDUSD) pays remaining FDUSD debt
const SHORT_AMOUNT_USDT = parseEther("0.1"); // borrow 0.1 FDUSD per open (18 dec mock)
const LONG_AMOUNT_SOL_SMALL = parseEther("0.001"); // SOL "received" in open swap (Scenario I)

// ---------------------------------------------------------------------------
// Minimal ABIs
// ---------------------------------------------------------------------------
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function faucet(uint256 amount)",
  "function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let saltCounter = 0;
// Random nonce generated once per script invocation so salts never collide across runs
// even when scenarios are executed individually (saltCounter would restart from 0 each time).
const SESSION_NONCE = ethers.BigNumber.from(ethers.utils.randomBytes(16));

/**
 * Builds manipulated swap calldata for testnet (no real DEX needed).
 *
 * The caller must pre-fund SwapHelper with `amountOut` of `tokenOut` BEFORE
 * calling this function, so the SwapHelper can transfer those tokens to the recipient.
 *
 * Flow inside SwapHelper multicall:
 *   1. sweep(tokenIn, dead)       → consume any tokenIn SwapHelper received
 *   2. genericCall → tokenOut.transfer(recipient, amountOut)  → deliver output
 *
 * @param backendSigner  Wallet whose address = SwapHelper.backendSigner()
 * @param tokenIn        Address of the input token (will be swept to dead)
 * @param tokenOut       Address of the output token (pre-loaded on SwapHelper)
 * @param amountOut      Amount of tokenOut to transfer to recipient
 * @param recipient      Who receives the output (LeverageManager or RPM)
 * @param skipSweep      Set true when there is no tokenIn to sweep (e.g. profit leg only)
 */
async function buildManipulatedSwapData(
  backendSigner: Wallet,
  tokenIn: string,
  tokenOut: string,
  amountOut: BigNumber,
  recipient: string,
  skipSweep: boolean = false,
): Promise<string> {
  const swapHelperIface = (await hre.ethers.getContractAt("SwapHelper", SWAP_HELPER_ADDRESS)).interface;
  const erc20Iface = new ethers.utils.Interface(ERC20_ABI);

  const calls: string[] = [];

  if (!skipSweep) {
    calls.push(swapHelperIface.encodeFunctionData("sweep", [tokenIn, DEAD_ADDRESS]));
  }

  const transferData = erc20Iface.encodeFunctionData("transfer", [recipient, amountOut]);
  calls.push(swapHelperIface.encodeFunctionData("genericCall", [tokenOut, transferData]));

  const TEN_YEARS = 10 * 365 * 24 * 60 * 60;
  const deadline = Math.floor(Date.now() / 1000) + TEN_YEARS;
  const salt = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["uint256", "address", "uint256"], [++saltCounter, recipient, SESSION_NONCE]),
  );

  const domain = {
    name: "VenusSwap",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: SWAP_HELPER_ADDRESS,
  };

  const types = {
    Multicall: [
      { name: "caller", type: "address" },
      { name: "calls", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  const signature = await backendSigner._signTypedData(domain, types, {
    caller: recipient,
    calls,
    deadline,
    salt,
  });

  return swapHelperIface.encodeFunctionData("multicall", [calls, deadline, salt, signature]);
}

/**
 * Attempt to call token.faucet() if available. If the token does not have
 * a faucet function, silently continue (deployer must pre-fund manually).
 */
async function tryFaucet(token: ethers.Contract, amount: BigNumber, label: string): Promise<void> {
  try {
    const tx = await token.faucet(amount, { gasLimit: 300_000 });
    await tx.wait();
    console.log(`  [faucet] minted ${amount.toString()} of ${label}`);
  } catch {
    console.log(`  [faucet] ${label} has no faucet — using deployer balance`);
  }
}

/**
 * Approve `spender` to spend `amount` of `token` on behalf of `owner`.
 * Skips the on-chain transaction when the existing allowance is already sufficient,
 * saving gas on repeated script runs.
 */
async function ensureApproval(
  token: ethers.Contract,
  owner: ethers.Signer,
  spender: string,
  amount: BigNumber,
  label: string,
): Promise<void> {
  const ownerAddress = await owner.getAddress();
  const current: BigNumber = await token.allowance(ownerAddress, spender);
  if (current.gte(amount)) {
    console.log(`  [approve] ${label} allowance sufficient (${ethers.utils.formatEther(current)}) — skipping`);
    return;
  }
  await (await token.connect(owner).approve(spender, amount)).wait();
  console.log(`  [approve] ${label} approved ${ethers.utils.formatEther(amount)}`);
}

/**
 * Returns true if a position account already exists for (user, longVToken, shortVToken).
 * When true the scenario logs current state and skips all transactions, avoiding redundant
 * on-chain calls on re-runs of the script.
 * Uses pos.isActive as the gate: false means the scenario hasn't been run yet (or was deactivated).
 */
async function positionAlreadyExists(
  rpm: ethers.Contract,
  user: Wallet,
  longVToken: string,
  shortVToken: string,
): Promise<boolean> {
  const pos = await rpm.getPosition(user.address, longVToken, shortVToken);
  if (!pos.isActive) return false;
  const [shortVTokenContract, dsaVTokenContract] = await Promise.all([
    hre.ethers.getContractAt("IVToken", shortVToken),
    hre.ethers.getContractAt("IVToken", pos.dsaVToken),
  ]);
  const [longBal, shortDebt, dsaBal] = await Promise.all([
    rpm.callStatic.getLongCollateralBalance(user.address, longVToken, shortVToken),
    shortVTokenContract.callStatic.borrowBalanceCurrent(pos.positionAccount),
    dsaVTokenContract.callStatic.balanceOfUnderlying(pos.positionAccount),
    // hre.ethers.getContractAt("ComptrollerMock", COMPTROLLER_ADDRESS)
    //   .then(c => c.getAccountLiquidity(pos.positionAccount)),
  ]);

  // Leverage stored in the position struct (set at activatePosition time)
  const leverageFmt = ethers.utils.formatEther(pos.effectiveLeverage) + "×";

  // Health factor from Comptroller: liquidity > 0 → healthy, shortfall > 0 → liquidatable
  // const [, liquidity, shortfall] = accountLiquidity;
  // const healthFmt = shortfall.gt(0)
  //   ? `LIQUIDATABLE (shortfall $${ethers.utils.formatEther(shortfall)})`
  //   : `healthy (surplus $${ethers.utils.formatEther(liquidity)})`;

  console.log("  [skip] Position already exists — current state:");
  console.log("    positionAccount         :", pos.positionAccount);
  console.log("    isActive                :", pos.isActive, " cycleId:", pos.cycleId.toString());
  console.log("    suppliedPrincipalVTokens:", pos.suppliedPrincipalVTokens.toString());
  console.log("    longCollateral          :", ethers.utils.formatEther(longBal));
  console.log("    dsaBalance (underlying) :", ethers.utils.formatEther(dsaBal));
  console.log("    shortDebt               :", ethers.utils.formatEther(shortDebt));
  console.log("    effectiveLeverage       :", leverageFmt);
  // console.log("    healthFactor            :", healthFmt);
  return true;
}

/**
 * Transfer BNB from deployer to a test user for gas.
 */
async function fundUserGas(deployer: ethers.Signer, userAddress: string): Promise<void> {
  const tx = await deployer.sendTransaction({ to: userAddress, value: GAS_BUDGET });
  await tx.wait();
  console.log(`  [gas] sent ${ethers.utils.formatEther(GAS_BUDGET)} BNB to ${userAddress}`);
}

/**
 * Transfer FDUSD from deployer to a test user for principal.
 */
async function fundUserUSDT(FDUSD: ethers.Contract, userAddress: string, amount: BigNumber): Promise<void> {
  const tx = await FDUSD.transfer(userAddress, amount);
  await tx.wait();
  console.log(`  [token] sent ${ethers.utils.formatEther(amount)} FDUSD to ${userAddress}`);
}

/**
 * Logs before/after each on-chain transaction so a failed run shows exactly which
 * call to retry. Prints the tx hash immediately after submission (before confirmation)
 * so the transaction is traceable even if .wait() times out or reverts.
 */
async function sendTx(label: string, txPromise: Promise<ethers.ContractTransaction>): Promise<void> {
  console.log(`  [tx] ${label} ...`);
  const tx = await txPromise;
  console.log(`       hash: ${tx.hash}`);
  await tx.wait();
  console.log(`       confirmed`);
}

// ---------------------------------------------------------------------------
// Scenario implementations
// ---------------------------------------------------------------------------

/**
 * Scenario A — Activate only (principal supplied, no leverage opened)
 *
 * State after: DSA principal deposited, no long collateral, no short borrow.
 * Events:       PositionActivated, PrincipalSupplied
 */
async function scenarioA_ActivateOnly(user: Wallet, FDUSD: ethers.Contract): Promise<void> {
  console.log("\n[Scenario A] Activate-only position for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");

  await sendTx(
    "activatePosition (vTHE/vSOL)",
    rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );

  const position = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  console.log("  positionAccount:", position.positionAccount);
  console.log("  isActive:", position.isActive, " cycleId:", position.cycleId.toString());
  console.log("  suppliedPrincipalVTokens:", position.suppliedPrincipalVTokens.toString());
}

/**
 * Scenario B — Activate + Open (standard leveraged position)
 *
 * State after: DSA principal + long collateral (THE) + short borrow (SOL).
 * Events:       PositionActivated, PositionOpened
 */
async function scenarioB_OpenPosition(
  user: Wallet,
  FDUSD: ethers.Contract,
  THE: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario B] Activate + Open position for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vTHE/vSOL)",
    rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );

  // Pre-fund SwapHelper with THE (the long token the "swap" will deliver)
  await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));

  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS, // tokenIn: short (SOL) that LeverageManager sends to SwapHelper
    CAKE_ADDRESS, // tokenOut: long (THE) delivered to LeverageManager
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );

  await sendTx(
    "openPosition (vTHE/vSOL)",
    rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData),
  );

  const veth = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);
  const vcake = await hre.ethers.getContractAt("IVToken", vCAKE_ADDRESS, user);
  const pos = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  const debt = await veth.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await vcake.callStatic.balanceOfUnderlying(pos.positionAccount);
  console.log("  shortDebt (SOL):", ethers.utils.formatEther(debt));
  console.log("  longCollateral (THE):", ethers.utils.formatEther(longBal));
}

/**
 * Scenario C — Activate + Open + Supply More Principal + Second Open (scale-up)
 *
 * State after: Increased DSA principal + more long collateral + more short borrow.
 * Events:       PositionActivated, PositionOpened, PrincipalSupplied, PositionOpened
 */
async function scenarioC_OpenAndScalePrincipal(
  user: Wallet,
  FDUSD: ethers.Contract,
  THE: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario C] Activate + Open + Scale for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  // // First activation + open
  // await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT.mul(2), "FDUSD");
  // await sendTx("activatePosition (vTHE/vSOL)", rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE));

  // await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));
  const openSwapData1 = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS,
    CAKE_ADDRESS,
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition #1 (vTHE/vSOL)",
    rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData1),
  );
  console.log("  First open done");

  // Supply more principal
  await sendTx("supplyPrincipal (vTHE/vSOL)", rpm.supplyPrincipal(vCAKE_ADDRESS, vSOL_ADDRESS, PRINCIPAL_USDT));
  console.log("  Extra principal supplied");

  // Second open (scale position)
  await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));
  const openSwapData2 = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS,
    CAKE_ADDRESS,
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition #2 (vTHE/vSOL, scale)",
    rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData2),
  );
  console.log("  Second open done — position scaled");
}

/**
 * Scenario D — Activate + Open + Partial Close with Profit (50%, repay only, no profit leg)
 *
 * State after: 50% of debt repaid, 50% of long redeemed, position still active.
 * Events:       PositionActivated, PositionOpened, PositionClosed (closeFractionBps=50)
 */
async function scenarioD_PartialCloseProfit(
  user: Wallet,
  FDUSD: ethers.Contract,
  THE: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario D] Activate + Open + Partial Close (50%, profit) for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  const vsolContract = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);

  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx("activatePosition (vTHE/vSOL)", rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE));

  await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS,
    CAKE_ADDRESS,
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx("openPosition (vTHE/vSOL)", rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData));

  // Read current debt and long balance for calculations
  const pos = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  const currentDebt = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);

  const CLOSE_BPS = 50; // 50%
  const debtToRepay = currentDebt.mul(CLOSE_BPS).div(100);
  const longToRedeem = longBal.mul(CLOSE_BPS).div(100);

  // Repay swap: LONG (THE) → SHORT (SOL), deliver short to LeverageManager
  const repayOut = debtToRepay.mul(102).div(100); // 2% buffer
  await sendTx("SOL → SwapHelper (prefund repay)", sol.transfer(SWAP_HELPER_ADDRESS, repayOut));
  const repaySwapData = await buildManipulatedSwapData(
    backendSigner,
    CAKE_ADDRESS,
    SOL_ADDRESS,
    repayOut,
    LEVERAGE_MANAGER_ADDRESS,
  );
  console.log("repaySwapData", repaySwapData);
  console.log(
    vCAKE_ADDRESS,
    vSOL_ADDRESS,
    CLOSE_BPS,
    longToRedeem, // long to redeem for repay
    repayOut, // minAmountOutRepay: buffered (+2%) so interest accrual between read and exec doesn't revert
    repaySwapData,
  );
  await sendTx(
    `closeWithProfit (vTHE/vSOL, ${CLOSE_BPS}% partial)`,
    rpm.closeWithProfit(
      vCAKE_ADDRESS,
      vSOL_ADDRESS,
      CLOSE_BPS,
      longToRedeem, // long to redeem for repay
      repayOut, // minAmountOutRepay: buffered (+2%) so interest accrual between read and exec doesn't revert
      repaySwapData,
      0, // no profit leg
      0,
      "0x",
    ),
  );

  const debtAfter = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  console.log("  Debt before:", ethers.utils.formatEther(currentDebt), "SOL");
  console.log("  Debt after :", ethers.utils.formatEther(debtAfter), "SOL");
  console.log("  Position still active:", (await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS)).isActive);
}

/**
 * Scenario E — Activate + Open + Full Close with Profit (100%, with profit leg)
 *
 * State after: long=0, debt=0, isActive=true (position NOT deactivated), profit added as DSA principal.
 * Events:       PositionActivated, PositionOpened, PositionClosed (100%), ProfitConverted
 */
async function scenarioE_FullCloseWithProfit(
  user: Wallet,
  FDUSD: ethers.Contract,
  THE: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario E] Activate + Open + Full Close with Profit for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  const vsolContract = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);

  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vTHE/vSOL)",
    rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );

  await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS,
    CAKE_ADDRESS,
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition (vTHE/vSOL)",
    rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData),
  );

  const pos = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  const currentDebt = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);

  // Split long into: repay portion + profit portion
  // Repay needs enough THE → SOL to cover full debt. For simplicity split 60%/40%.
  const longForRepay = longBal.mul(60).div(100);
  const longForProfit = longBal.sub(longForRepay);

  // Repay swap: longForRepay THE → SOL, delivers currentDebt + buffer to LM
  const repayOut = currentDebt.mul(102).div(100);
  await sendTx("SOL → SwapHelper (prefund repay)", sol.transfer(SWAP_HELPER_ADDRESS, repayOut));
  const repaySwapData = await buildManipulatedSwapData(
    backendSigner,
    CAKE_ADDRESS,
    SOL_ADDRESS,
    repayOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  // Profit swap: longForProfit THE → DSA (FDUSD), delivered to RPM
  const profitDsaOut = parseEther("5"); // mock: 5 FDUSD profit
  await sendTx("FDUSD → SwapHelper (prefund profit leg)", FDUSD.transfer(SWAP_HELPER_ADDRESS, profitDsaOut));
  const profitSwapData = await buildManipulatedSwapData(
    backendSigner,
    CAKE_ADDRESS,
    USDT_ADDRESS,
    profitDsaOut,
    RPM_ADDRESS,
  );

  await sendTx(
    "closeWithProfit (vTHE/vSOL, 100% with profit)",
    rpm.closeWithProfit(
      vCAKE_ADDRESS,
      vSOL_ADDRESS,
      100, // 100% close
      longForRepay,
      repayOut, // minAmountOutRepay: buffered (+2%) to cover interest accrual between read and exec
      repaySwapData,
      longForProfit,
      0, // minAmountOutProfit = 0 for seeding
      profitSwapData,
    ),
  );

  const debtAfter = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longAfter = await rpm.callStatic.getLongCollateralBalance(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  console.log("  Debt after:", ethers.utils.formatEther(debtAfter), "SOL (should be 0)");
  console.log("  Long after:", ethers.utils.formatEther(longAfter), "THE (should be 0)");
  console.log("  isActive:", (await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS)).isActive);
}

/**
 * Scenario F — Activate + Open + Partial Close with Loss (40%, DSA covers shortfall)
 *
 * Like Scenario D (partial profit close) but simulates a loss: the long collateral
 * is worth less than the portion of debt being repaid, so DSA principal tops up the gap.
 *
 * Close flow (closeWithLoss, closeFractionBps=40):
 *   first leg : 40% of long THE → SOL swap, but only covers 50% of the 40% debt portion
 *   second leg: DSA (FDUSD) → SOL swap via SwapHelper, covers the remaining 50%
 *
 * State after: 60% of debt + 60% of long still remain, DSA principal reduced, position active.
 * Events:       PositionActivated, PositionOpened, PositionClosed (closeFractionBps=40)
 */
async function scenarioF_PartialCloseWithLoss(
  user: Wallet,
  FDUSD: ethers.Contract,
  THE: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario F] Activate + Open + Partial Close (40%, loss) for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  const vsolContract = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);

  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vTHE/vSOL)",
    rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );

  await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS,
    CAKE_ADDRESS,
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition (vTHE/vSOL)",
    rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData),
  );

  const pos = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  const currentDebt = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);

  const CLOSE_BPS = 40; // 40%

  // The slice of debt and long being closed
  const debtForClose = currentDebt.mul(CLOSE_BPS).div(100);
  const longForClose = longBal.mul(CLOSE_BPS).div(100);

  // First leg: redeem 40% of long THE → SOL, but only covers 50% of debtForClose (simulated loss)
  const shortFromFirstLeg = debtForClose.mul(50).div(100);
  const firstOut = shortFromFirstLeg.mul(102).div(100); // 2% buffer
  await sendTx("SOL → SwapHelper (prefund first leg)", sol.transfer(SWAP_HELPER_ADDRESS, firstOut));
  const firstSwapData = await buildManipulatedSwapData(
    backendSigner,
    CAKE_ADDRESS, // tokenIn  (THE long redeemed → swept to dead)
    SOL_ADDRESS, // tokenOut (SOL pre-loaded → transferred to LM for partial repay)
    firstOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  // Second leg: DSA (FDUSD) → SOL covers the remaining 50% of debtForClose
  // DSA != short in the standard layout so a real SwapHelper swap is needed here
  const remaining = debtForClose.sub(shortFromFirstLeg);
  const secondOut = remaining.mul(102).div(100); // 2% buffer
  await sendTx("SOL → SwapHelper (prefund second leg)", sol.transfer(SWAP_HELPER_ADDRESS, secondOut));
  const secondSwapData = await buildManipulatedSwapData(
    backendSigner,
    USDT_ADDRESS, // tokenIn  (FDUSD redeemed from DSA → swept to dead)
    SOL_ADDRESS, // tokenOut (SOL pre-loaded → transferred to LM for remaining repay)
    secondOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  // DSA to redeem: generously large flat amount; oracle prices are mocked on testnet
  const dsaToRedeem = parseEther("20"); // 20 FDUSD — large enough to cover remaining debt value

  await sendTx(
    `closeWithLoss (vTHE/vSOL, ${CLOSE_BPS}% partial, DSA covers shortfall)`,
    rpm.closeWithLoss(
      vCAKE_ADDRESS,
      vSOL_ADDRESS,
      CLOSE_BPS, // closeFractionBps = 40
      longForClose, // 40% of long THE for first swap
      shortFromFirstLeg, // partial SOL repaid from first swap
      shortFromFirstLeg, // minAmountOutFirst
      firstSwapData,
      dsaToRedeem, // DSA (FDUSD) redeemed for second swap
      secondOut, // minAmountOutSecond (buffered to absorb accrued interest)
      secondSwapData,
    ),
  );

  const debtAfter = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longAfter = await rpm.callStatic.getLongCollateralBalance(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  console.log("  Debt before:", ethers.utils.formatEther(currentDebt), "SOL");
  console.log("  Debt after :", ethers.utils.formatEther(debtAfter), "SOL (should be ~60% remaining)");
  console.log("  Long before:", ethers.utils.formatEther(longBal), "THE");
  console.log("  Long after :", ethers.utils.formatEther(longAfter), "THE (should be ~60% remaining)");
  console.log("  Position still active:", (await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS)).isActive);
}

/**
 * Scenario G — Activate + Open + Full Close with Loss (100%, DSA covers shortfall)
 *
 * Simulates a loss scenario: long value < short debt, so DSA principal is used
 * to repay the remaining short borrow.
 *
 * State after: long=0, debt=0, DSA principal reduced, isActive=true.
 * Events:       PositionActivated, PositionOpened, PositionClosed (100%)
 */
async function scenarioG_FullCloseWithLoss(
  user: Wallet,
  FDUSD: ethers.Contract,
  THE: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario G] Activate + Open + Full Close with Loss for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  const vsolContract = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);

  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vTHE/vSOL)",
    rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );

  await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS,
    CAKE_ADDRESS,
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition (vTHE/vSOL)",
    rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData),
  );

  const pos = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  const currentDebt = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);

  // First leg: redeem ALL long → SHORT, but only covers 50% of debt (simulated loss)
  const shortFromFirstLeg = currentDebt.mul(50).div(100);
  const firstOut = shortFromFirstLeg.mul(102).div(100);
  await sendTx("SOL → SwapHelper (prefund first leg)", sol.transfer(SWAP_HELPER_ADDRESS, firstOut));
  const firstSwapData = await buildManipulatedSwapData(
    backendSigner,
    CAKE_ADDRESS,
    SOL_ADDRESS,
    firstOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  // Second leg: redeem DSA (FDUSD) → SHORT (SOL) for the remaining 50% of debt
  const remaining = currentDebt.sub(shortFromFirstLeg);
  const secondOut = remaining.mul(102).div(100);
  await sendTx("SOL → SwapHelper (prefund second leg)", sol.transfer(SWAP_HELPER_ADDRESS, secondOut));
  const secondSwapData = await buildManipulatedSwapData(
    backendSigner,
    USDT_ADDRESS,
    SOL_ADDRESS,
    secondOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  // DSA to redeem: need enough FDUSD (18 dec mock) to cover remaining SOL debt value.
  // Testnet oracle prices are mock — use a generously large flat FDUSD amount to guarantee
  // the position account holds enough DSA principal to pass the contract's validation.
  // Adjust this constant if the oracle price ratio causes a revert.
  const dsaToRedeem = parseEther("50"); // 50 FDUSD (18 dec) — large enough for testnet mocks

  await sendTx(
    "closeWithLoss (vTHE/vSOL, 100%)",
    rpm.closeWithLoss(
      vCAKE_ADDRESS,
      vSOL_ADDRESS,
      100, // closeFractionBps
      longBal, // all long for first swap
      shortFromFirstLeg, // partial repay from first swap
      shortFromFirstLeg, // minAmountOutFirst
      firstSwapData,
      dsaToRedeem, // DSA redeemed for second swap
      secondOut, // minAmountOutSecond
      secondSwapData,
    ),
  );

  const debtAfter = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  console.log("  Debt after:", ethers.utils.formatEther(debtAfter), "SOL (should be 0)");
  console.log("  isActive:", (await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS)).isActive);
}

/**
 * Scenario H — Activate + Open + Full Close + Deactivate
 *
 * State after: isActive = false, position account still exists (can be reactivated).
 * Events:       PositionActivated, PositionOpened, PositionClosed, PositionDeactivated
 */
async function scenarioH_DeactivatedPosition(
  user: Wallet,
  FDUSD: ethers.Contract,
  THE: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario H] Activate + Open + Full Close + Deactivate for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vCAKE_ADDRESS, vSOL_ADDRESS)) return;

  const vsolContract = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);

  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vTHE/vSOL)",
    rpm.activatePosition(vCAKE_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );

  await sendTx("THE → SwapHelper (prefund long)", THE.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS,
    CAKE_ADDRESS,
    LONG_AMOUNT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition (vTHE/vSOL)",
    rpm.openPosition(vCAKE_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT, openSwapData),
  );

  const pos = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  const currentDebt = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);

  // Full close with profit (repay leg + profit leg)
  // Split long collateral: 60% goes to repay, 40% goes to profit
  const longForRepay = longBal.mul(60).div(100);
  const longForProfit = longBal.sub(longForRepay);

  // Repay leg: prefund SOL to SwapHelper, swap THE → SOL to repay debt
  const repayOut = currentDebt.mul(102).div(100);
  await sendTx("SOL → SwapHelper (prefund repay)", sol.transfer(SWAP_HELPER_ADDRESS, repayOut));
  const repaySwapData = await buildManipulatedSwapData(
    backendSigner,
    CAKE_ADDRESS,
    SOL_ADDRESS,
    repayOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  // Profit leg: prefund FDUSD to SwapHelper, swap THE → FDUSD, deliver to RPM
  const profitDsaOut = parseEther("5"); // 5 FDUSD profit
  await sendTx("FDUSD → SwapHelper (prefund profit)", FDUSD.transfer(SWAP_HELPER_ADDRESS, profitDsaOut));
  const profitSwapData = await buildManipulatedSwapData(
    backendSigner,
    CAKE_ADDRESS,
    USDT_ADDRESS,
    profitDsaOut,
    RPM_ADDRESS,
  );

  await sendTx(
    "closeWithProfit (vTHE/vSOL, 100% with profit leg)",
    rpm.closeWithProfit(
      vCAKE_ADDRESS,
      vSOL_ADDRESS,
      100,
      longForRepay,
      repayOut,
      repaySwapData,
      longForProfit,
      profitDsaOut,
      profitSwapData,
    ),
  );
  console.log("  Position fully closed");

  // Withdraw remaining DSA principal before deactivation
  const utilizationData = await rpm.callStatic.getUtilizationInfo(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  if (utilizationData.withdrawableAmount.gt(0)) {
    await sendTx(
      `withdrawPrincipal (${ethers.utils.formatEther(utilizationData.withdrawableAmount)} FDUSD)`,
      rpm.withdrawPrincipal(vCAKE_ADDRESS, vSOL_ADDRESS, utilizationData.withdrawableAmount),
    );
    console.log("  Principal withdrawn:", ethers.utils.formatEther(utilizationData.withdrawableAmount), "FDUSD");
  }

  await sendTx("deactivatePosition (vTHE/vSOL)", rpm.deactivatePosition(vCAKE_ADDRESS, vSOL_ADDRESS));

  const finalPos = await rpm.getPosition(user.address, vCAKE_ADDRESS, vSOL_ADDRESS);
  console.log("  isActive after deactivation:", finalPos.isActive, "(should be false)");
  console.log("  cycleId:", finalPos.cycleId.toString());
}

/**
 * Scenario I — Long == DSA (longVToken = vFDUSD, shortVToken = vSOL, DSA = vFDUSD)
 *
 * The long asset and the DSA share the same vToken market (vFDUSD).
 * The position account's FDUSD balance is split internally:
 *   - suppliedPrincipalVTokens tracks the DSA (principal) portion
 *   - getLongCollateralBalance returns only the leveraged FDUSD portion
 *
 * Open:   borrow SOL (short), manipulated swap SOL → FDUSD (long, same market as DSA)
 * Close:  100% closeWithProfit
 *           repay leg : FDUSD long → SOL short  (real swap via SwapHelper)
 *           profit leg: FDUSD long → FDUSD DSA   (NO swap — same asset, swapDataProfit="0x",
 *                        contract reclassifies excess long as additional DSA principal internally)
 *
 * Events: PositionActivated, PositionOpened, PositionClosed (100%), ProfitConverted
 */
async function scenarioI_LongEqualsDSA(
  user: Wallet,
  FDUSD: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario I] Long == DSA (vFDUSD/vSOL) for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vUSDT_ADDRESS, vSOL_ADDRESS)) return;

  const vsolContract = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);

  // Activate: longVToken = vFDUSD, shortVToken = vSOL, DSA = vFDUSD (same market as long)
  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vFDUSD/vSOL)",
    rpm.activatePosition(vUSDT_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );
  console.log("  Activated (longVToken=vFDUSD, shortVToken=vSOL)");

  // Open: borrow SOL → swap to FDUSD (long). Pre-fund SwapHelper with FDUSD.
  // tokenIn = SOL (short sent by LeverageManager), tokenOut = FDUSD (long delivered back to LM)
  await sendTx("FDUSD → SwapHelper (prefund long)", FDUSD.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT_USDT));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS, // tokenIn  (SOL sent by LM → swept to dead)
    USDT_ADDRESS, // tokenOut (FDUSD pre-loaded on SwapHelper → transferred to LM)
    LONG_AMOUNT_USDT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition (vFDUSD/vSOL)",
    rpm.openPosition(vUSDT_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT_USDT, openSwapData),
  );
  console.log("  Opened: borrowed", ethers.utils.formatEther(SHORT_AMOUNT), "SOL; received FDUSD as long");

  // Read state
  const pos = await rpm.getPosition(user.address, vUSDT_ADDRESS, vSOL_ADDRESS);
  const currentDebt = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  // getLongCollateralBalance subtracts principal vTokens so we get only the leveraged FDUSD
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vUSDT_ADDRESS, vSOL_ADDRESS);
  console.log("  shortDebt  (SOL):", ethers.utils.formatEther(currentDebt));
  console.log("  longBal (FDUSD)  :", ethers.utils.formatEther(longBal));

  // Close 100% with profit
  // Repay leg:  redeem FDUSD long → swap to SOL → repay SOL debt (real swap via SwapHelper)
  // Profit leg: remaining FDUSD long → DSA = same token, swapDataProfit="0x" (no swap)
  const longForRepay = longBal.mul(60).div(100); // 60% of long used for repay
  const longForProfit = longBal.sub(longForRepay); // 40% reclassified as DSA principal

  const repayOut = currentDebt.mul(102).div(100); // 2% buffer for interest
  await sendTx("SOL → SwapHelper (prefund repay)", sol.transfer(SWAP_HELPER_ADDRESS, repayOut));
  const repaySwapData = await buildManipulatedSwapData(
    backendSigner,
    USDT_ADDRESS, // tokenIn  (FDUSD redeemed from long position → swept to dead)
    SOL_ADDRESS, // tokenOut (SOL pre-loaded → transferred to LM for repay)
    repayOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  await sendTx(
    "closeWithProfit (vFDUSD/vSOL, 100%, long==DSA)",
    rpm.closeWithProfit(
      vUSDT_ADDRESS,
      vSOL_ADDRESS,
      100, // 100% close
      longForRepay, // FDUSD long redeemed for repay leg
      repayOut, // minAmountOutRepay: buffered (+2%) to cover interest accrual between read and exec
      repaySwapData,
      longForProfit, // FDUSD long to "convert" to profit — no swap since long==DSA
      longForProfit, // minAmountOutProfit = same amount (profit stays in FDUSD)
      "0x", // swapDataProfit = empty: contract handles long==DSA internally, no swap needed
    ),
  );

  const debtAfter = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longAfter = await rpm.callStatic.getLongCollateralBalance(user.address, vUSDT_ADDRESS, vSOL_ADDRESS);
  const finalPos = await rpm.getPosition(user.address, vUSDT_ADDRESS, vSOL_ADDRESS);
  console.log("  Debt after  :", ethers.utils.formatEther(debtAfter), "SOL (should be 0)");
  console.log("  Long after  :", ethers.utils.formatEther(longAfter), "FDUSD (should be 0)");
  console.log(
    "  Principal   :",
    finalPos.suppliedPrincipalVTokens.toString(),
    "vTokens (principal increased by profit)",
  );
  console.log("  isActive    :", finalPos.isActive, "(should be true — not deactivated)");
}

/**
 * Scenario J — DSA == Short  (longVToken = vSOL, shortVToken = vFDUSD, DSA = vFDUSD)
 *              with loss close where DSA repays the remaining FDUSD debt directly (no swap)
 *
 * The DSA and the short token share the same vToken market (vFDUSD).
 * When closing with loss the second leg calls exitSingleAssetLeverage instead of exitLeverage:
 *   it redeems DSA (FDUSD) vTokens and repays the FDUSD borrow directly without routing through SwapHelper.
 * Therefore swapDataSecond = "0x" and no SwapHelper pre-funding is needed for the second leg.
 *
 * Open:   borrow FDUSD (short), manipulated swap FDUSD → SOL (long)
 * Close:  100% closeWithLoss
 *           first leg : SOL long → FDUSD short (via SwapHelper), covers ~50% of debt
 *           second leg: DSA (FDUSD) → FDUSD debt (NO swap, swapDataSecond="0x",
 *                        contract calls exitSingleAssetLeverage to repay remainder directly)
 *
 * Events: PositionActivated, PositionOpened, PositionClosed (100%)
 */
async function scenarioJ_DSAEqualsShortWithLoss(
  user: Wallet,
  FDUSD: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario J] DSA == Short (vSOL/vFDUSD) loss close for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vSOL_ADDRESS, vUSDT_ADDRESS)) return;

  const vusdtContract = await hre.ethers.getContractAt("IVToken", vUSDT_ADDRESS, user);

  // Activate: longVToken = vSOL, shortVToken = vFDUSD, DSA = vFDUSD (same as short)
  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vSOL/vFDUSD)",
    rpm.activatePosition(vSOL_ADDRESS, vUSDT_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );
  console.log("  Activated (longVToken=vSOL, shortVToken=vFDUSD, DSA=vFDUSD)");

  // Open: borrow FDUSD (short) → swap to SOL (long). Pre-fund SwapHelper with SOL.
  // tokenIn = FDUSD (short sent by LeverageManager), tokenOut = SOL (long delivered back to LM)
  await sendTx("SOL → SwapHelper (prefund long)", sol.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT_SOL_SMALL));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    USDT_ADDRESS, // tokenIn  (FDUSD short sent by LM → swept to dead)
    SOL_ADDRESS, // tokenOut (SOL pre-loaded → transferred to LM as long)
    LONG_AMOUNT_SOL_SMALL,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition (vSOL/vFDUSD)",
    rpm.openPosition(vSOL_ADDRESS, vUSDT_ADDRESS, 0, SHORT_AMOUNT_USDT, LONG_AMOUNT_SOL_SMALL, openSwapData),
  );
  console.log("  Opened: borrowed", ethers.utils.formatEther(SHORT_AMOUNT_USDT), "FDUSD; received SOL as long");

  // Read state
  const pos = await rpm.getPosition(user.address, vSOL_ADDRESS, vUSDT_ADDRESS);
  const currentDebt = await vusdtContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vSOL_ADDRESS, vUSDT_ADDRESS);
  console.log("  shortDebt  (FDUSD):", ethers.utils.formatEther(currentDebt));
  console.log("  longBal    (SOL) :", ethers.utils.formatEther(longBal));

  // Close 100% with loss — DSA covers the second leg
  //
  // First leg: redeem all long SOL, swap SOL→USDT via SwapHelper.
  //   Simulate a loss: the swap only returns 50% of the FDUSD debt.
  //   shortAmountToRepayForFirstSwap must be <= expectedShortToRepay (= totalDebt for 100%).
  const shortFromFirstLeg = currentDebt.mul(50).div(100); // only 50% covered by first leg
  const firstOut = shortFromFirstLeg.mul(102).div(100); // 2% buffer for the swap mock
  await sendTx("FDUSD → SwapHelper (prefund first leg)", FDUSD.transfer(SWAP_HELPER_ADDRESS, firstOut));
  const firstSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS, // tokenIn  (SOL long redeemed → swept to dead)
    USDT_ADDRESS, // tokenOut (FDUSD pre-loaded → transferred to LM for partial repay)
    firstOut,
    LEVERAGE_MANAGER_ADDRESS,
  );

  // Second leg: DSA (FDUSD) covers remaining 50% of debt.
  //   Since dsaVToken == shortVToken the contract calls exitSingleAssetLeverage(dsaVToken, amountToRepaySecond).
  //   amountToRepaySecond = expectedShortToRepay - shortFromFirstLeg, then bumped by 2% for full close.
  //   We set dsaAmountToRedeemForSecondSwap to the bumped remaining so it matches what will actually be redeemed.
  //   minAmountOutSecond must be >= amountToRepaySecond (after the 2% bump applied internally).
  //   swapDataSecond = "0x" — not used when DSA == short.
  const remaining = currentDebt.sub(shortFromFirstLeg);
  const bumpedRemaining = remaining.mul(102).div(100); // 2% bump applied by contract for 100% close

  await sendTx(
    "closeWithLoss (vSOL/vFDUSD, 100%, DSA==short)",
    rpm.closeWithLoss(
      vSOL_ADDRESS,
      vUSDT_ADDRESS,
      100, // 100% close
      longBal, // all long SOL for first swap
      shortFromFirstLeg, // partial FDUSD repaid from first swap
      shortFromFirstLeg, // minAmountOutFirst >= shortAmountToRepayForFirstSwap
      firstSwapData,
      bumpedRemaining, // dsaAmountToRedeemForSecondSwap (must be <= principalUnderlying)
      bumpedRemaining, // minAmountOutSecond >= bumpedRemaining (the amount contract will repay)
      "0x", // swapDataSecond = empty: contract detects DSA==short and skips swap entirely
    ),
  );

  const debtAfter = await vusdtContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longAfter = await rpm.callStatic.getLongCollateralBalance(user.address, vSOL_ADDRESS, vUSDT_ADDRESS);
  const finalPos = await rpm.getPosition(user.address, vSOL_ADDRESS, vUSDT_ADDRESS);
  console.log("  Debt after  :", ethers.utils.formatEther(debtAfter), "FDUSD (should be 0)");
  console.log("  Long after  :", ethers.utils.formatEther(longAfter), "SOL (should be 0)");
  console.log("  Principal   :", finalPos.suppliedPrincipalVTokens.toString(), "vTokens (reduced by loss repay)");
  console.log("  isActive    :", finalPos.isActive, "(should be true)");
}

/**
 * Scenario K — Long == DSA, 30% partial closeWithProfit (position stays open)
 *
 * Same market layout as Scenario I (vFDUSD long, vSOL short, DSA = vFDUSD).
 * Closes only 30% of the position, leaving 70% of long and debt remaining.
 *
 * Close:  30% closeWithProfit
 *           repay leg : 60% of the 30% slice FDUSD long → swap to SOL → repay SOL debt
 *           profit leg: 40% of the 30% slice FDUSD long → FDUSD DSA (NO swap, long==DSA)
 *
 * State after: isActive=true, ~70% of long and debt remain.
 * Events:      PositionActivated, PositionOpened, PositionClosed (30%), ProfitConverted
 */
async function scenarioK_LongEqualsDSAPartialClose(
  user: Wallet,
  FDUSD: ethers.Contract,
  sol: ethers.Contract,
  backendSigner: Wallet,
): Promise<void> {
  console.log("\n[Scenario K] Long == DSA, 30% partial close (vFDUSD/vSOL) for", user.address);
  const rpm = await hre.ethers.getContractAt("RelativePositionManager", RPM_ADDRESS, user);
  if (await positionAlreadyExists(rpm, user, vUSDT_ADDRESS, vSOL_ADDRESS)) return;

  const vsolContract = await hre.ethers.getContractAt("IVToken", vSOL_ADDRESS, user);

  // Activate: longVToken = vFDUSD, shortVToken = vSOL, DSA = vFDUSD (same market as long)
  await ensureApproval(FDUSD, user, RPM_ADDRESS, PRINCIPAL_USDT, "FDUSD");
  await sendTx(
    "activatePosition (vFDUSD/vSOL)",
    rpm.activatePosition(vUSDT_ADDRESS, vSOL_ADDRESS, DSA_INDEX, PRINCIPAL_USDT, LEVERAGE),
  );
  console.log("  Activated (longVToken=vFDUSD, shortVToken=vSOL)");

  // Open: borrow SOL → swap to FDUSD (long). Pre-fund SwapHelper with FDUSD.
  await sendTx("FDUSD → SwapHelper (prefund long)", FDUSD.transfer(SWAP_HELPER_ADDRESS, LONG_AMOUNT_USDT));
  const openSwapData = await buildManipulatedSwapData(
    backendSigner,
    SOL_ADDRESS, // tokenIn  (SOL sent by LM → swept to dead)
    USDT_ADDRESS, // tokenOut (FDUSD pre-loaded → transferred to LM)
    LONG_AMOUNT_USDT,
    LEVERAGE_MANAGER_ADDRESS,
  );
  await sendTx(
    "openPosition (vFDUSD/vSOL)",
    rpm.openPosition(vUSDT_ADDRESS, vSOL_ADDRESS, 0, SHORT_AMOUNT, LONG_AMOUNT_USDT, openSwapData),
  );
  console.log("  Opened: borrowed", ethers.utils.formatEther(SHORT_AMOUNT), "SOL; received FDUSD as long");

  // Read state
  const pos = await rpm.getPosition(user.address, vUSDT_ADDRESS, vSOL_ADDRESS);
  const currentDebt = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longBal = await rpm.callStatic.getLongCollateralBalance(user.address, vUSDT_ADDRESS, vSOL_ADDRESS);
  console.log("  shortDebt  (SOL):", ethers.utils.formatEther(currentDebt));
  console.log("  longBal (FDUSD)  :", ethers.utils.formatEther(longBal));

  // 30% partial close with profit (long==DSA, no swap on profit leg)
  // Split the 30% slice: 60% to repay leg, 40% to profit leg
  const longSlice30 = longBal.mul(30).div(100);
  const longForRepay30 = longSlice30.mul(60).div(100);
  const longForProfit30 = longSlice30.sub(longForRepay30);
  const repayOut30 = currentDebt.mul(30).div(100).mul(102).div(100); // 30% of debt + 2% buffer
  await sendTx("SOL → SwapHelper (prefund repay)", sol.transfer(SWAP_HELPER_ADDRESS, repayOut30));
  const repaySwapData30 = await buildManipulatedSwapData(
    backendSigner,
    USDT_ADDRESS, // tokenIn  (FDUSD redeemed → swept to dead)
    SOL_ADDRESS, // tokenOut (SOL pre-loaded → transferred to LM for repay)
    repayOut30,
    LEVERAGE_MANAGER_ADDRESS,
  );

  await sendTx(
    "closeWithProfit (vFDUSD/vSOL, 30%, long==DSA)",
    rpm.closeWithProfit(
      vUSDT_ADDRESS,
      vSOL_ADDRESS,
      30,
      longForRepay30,
      repayOut30,
      repaySwapData30,
      longForProfit30,
      longForProfit30, // minAmountOutProfit = same (no swap, same token)
      "0x", // long==DSA: contract reclassifies excess long as DSA principal internally
    ),
  );

  const debtAfter = await vsolContract.callStatic.borrowBalanceCurrent(pos.positionAccount);
  const longAfter = await rpm.callStatic.getLongCollateralBalance(user.address, vUSDT_ADDRESS, vSOL_ADDRESS);
  console.log("  Debt before:", ethers.utils.formatEther(currentDebt), "SOL");
  console.log("  Debt after :", ethers.utils.formatEther(debtAfter), "SOL (should be ~70% remaining)");
  console.log("  Long before:", ethers.utils.formatEther(longBal), "FDUSD");
  console.log("  Long after :", ethers.utils.formatEther(longAfter), "FDUSD (should be ~70% remaining)");
  console.log("  isActive   :", (await rpm.getPosition(user.address, vUSDT_ADDRESS, vSOL_ADDRESS)).isActive);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  console.log("Network:", network.name, "ChainID:", network.chainId);

  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Expected BSC testnet (chainId ${CHAIN_ID}), got ${network.chainId}`);
  }

  // Load deployer and backend signer from env
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const backendSignerKey = process.env.BACKEND_SIGNER_PRIVATE_KEY;

  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
  if (!backendSignerKey) throw new Error("BACKEND_SIGNER_PRIVATE_KEY not set in .env");

  const deployer = new ethers.Wallet(`0x${deployerKey}`, provider);
  const backendSigner = new ethers.Wallet(`0x${backendSignerKey}`, provider);

  console.log("Deployer :", deployer.address);
  console.log("Backend  :", backendSigner.address);

  const deployerBnb = await provider.getBalance(deployer.address);
  console.log("Deployer BNB:", ethers.utils.formatEther(deployerBnb));

  // Verify that backendSigner matches what SwapHelper expects
  const swapHelperView = await hre.ethers.getContractAt("SwapHelper", SWAP_HELPER_ADDRESS);
  const expectedSigner = await swapHelperView.backendSigner();
  if (expectedSigner.toLowerCase() !== backendSigner.address.toLowerCase()) {
    console.warn(
      `WARNING: SwapHelper.backendSigner() = ${expectedSigner}, but BACKEND_SIGNER_PRIVATE_KEY resolves to ${backendSigner.address}. Swap calldata will be rejected. Update the env var.`,
    );
  }

  // Token contracts connected to deployer
  const FDUSD = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, deployer);
  const THE = new ethers.Contract(CAKE_ADDRESS, ERC20_ABI, deployer);
  const sol = new ethers.Contract(SOL_ADDRESS, ERC20_ABI, deployer);

  // Faucet deployer tokens only when balance falls below the minimum threshold.
  // This avoids redundant on-chain transactions on subsequent runs of the script.
  console.log("\n--- Funding deployer with tokens ---");
  const FDUSD_MIN = parseEther("5000"); // top-up trigger for FDUSD
  const THE_MIN = parseEther("50"); // top-up trigger for THE
  const SOL_MIN = parseEther("5"); // top-up trigger for SOL

  if ((await FDUSD.balanceOf(deployer.address)).lt(FDUSD_MIN)) {
    await tryFaucet(FDUSD, parseEther("10000"), "FDUSD");
  } else {
    console.log("  [faucet] FDUSD already funded — skipping");
  }
  if ((await THE.balanceOf(deployer.address)).lt(THE_MIN)) {
    await tryFaucet(THE, parseEther("100"), "THE");
  } else {
    console.log("  [faucet] THE already funded — skipping");
  }
  if ((await sol.balanceOf(deployer.address)).lt(SOL_MIN)) {
    await tryFaucet(sol, parseEther("10"), "SOL");
  } else {
    console.log("  [faucet] SOL already funded — skipping");
  }

  // Read balances after any faucet calls so the buffer check below is accurate
  const usdtBal = await FDUSD.balanceOf(deployer.address);
  const cakeBal = await THE.balanceOf(deployer.address);
  const solBal = await sol.balanceOf(deployer.address);
  console.log("  Deployer FDUSD:", ethers.utils.formatEther(usdtBal));
  console.log("  Deployer THE  :", ethers.utils.formatEther(cakeBal));
  console.log("  Deployer SOL  :", ethers.utils.formatEther(solBal));

  // Generate 11 deterministic test-user wallets from deployer key
  // These are always the same for the same deployer key, making the script idempotent
  const users: Wallet[] = Array.from({ length: 11 }, (_, i) => {
    const childKey = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256"], [`0x${deployerKey}`, i + 1]),
    );
    return new ethers.Wallet(childKey, provider);
  });

  console.log("\n--- Test User Addresses ---");
  users.forEach((u, i) =>
    console.log(`  User ${String.fromCharCode(65 + i)} (Scenario ${String.fromCharCode(65 + i)}):`, u.address),
  );

  // Fund each test user with BNB for gas and FDUSD for principal
  console.log("\n--- Funding test users ---");
  const EXTRA_USDT_FOR_SWAPHELPER = parseEther("50"); // extra FDUSD for loss scenario SwapHelper prefunding (18 dec)
  const PER_USER_USDT = PRINCIPAL_USDT.add(EXTRA_USDT_FOR_SWAPHELPER);

  for (const [i, user] of users.entries()) {
    const userBnb = await provider.getBalance(user.address);
    if (userBnb.lt(GAS_BUDGET.div(2))) {
      await fundUserGas(deployer, user.address);
    } else {
      console.log(`  User ${String.fromCharCode(65 + i)} already has enough BNB`);
    }

    const userUsdt = await FDUSD.balanceOf(user.address);
    if (userUsdt.lt(PRINCIPAL_USDT)) {
      await fundUserUSDT(FDUSD, user.address, PER_USER_USDT);
    } else {
      console.log(`  User ${String.fromCharCode(65 + i)} already has enough FDUSD`);
    }
  }

  // Also ensure deployer has enough THE and SOL for SwapHelper prefunding across all scenarios
  // Each open needs LONG_AMOUNT THE; each close (repay) needs SHORT_AMOUNT SOL.
  // We allocate a generous buffer here; adjust if needed.
  const CAKE_NEEDED = LONG_AMOUNT.mul(10); // buffer for multiple opens across scenarios
  const SOL_NEEDED = SHORT_AMOUNT.mul(20); // buffer for repay legs

  const cakeNeeded = CAKE_NEEDED.sub(cakeBal.gt(CAKE_NEEDED) ? CAKE_NEEDED : cakeBal);
  const solNeeded = SOL_NEEDED.sub(solBal.gt(SOL_NEEDED) ? SOL_NEEDED : solBal);
  if (cakeNeeded.gt(0)) {
    console.log(`\nDeployer needs more THE — please top up ${ethers.utils.formatEther(cakeNeeded)} THE`);
  }
  if (solNeeded.gt(0)) {
    console.log(`Deployer needs more SOL — please top up ${ethers.utils.formatEther(solNeeded)} SOL`);
  }

  // ---------------------------------------------------------------------------
  // Run scenarios
  // ---------------------------------------------------------------------------
  console.log("\n=== Running position seed scenarios ===");

  // Scenario A — Activate only
  await scenarioA_ActivateOnly(users[0], FDUSD);

  // // Scenario B — Activate + Open
  await scenarioB_OpenPosition(users[1], FDUSD, THE, backendSigner);

  // // Scenario C — Activate + Open + Scale
  await scenarioC_OpenAndScalePrincipal(users[2], FDUSD, THE, backendSigner);

  // Scenario D — 50% Partial Close with Profit
  await scenarioD_PartialCloseProfit(users[3], FDUSD, THE, sol, backendSigner);

  // // Scenario E — 100% Full Close with Profit leg
  await scenarioE_FullCloseWithProfit(users[4], FDUSD, THE, sol, backendSigner);

  // Scenario F — 40% Partial Close with Loss (DSA covers shortfall)
  await scenarioF_PartialCloseWithLoss(users[5], FDUSD, THE, sol, backendSigner);

  // // Scenario G — 100% Full Close with Loss (DSA covers shortfall)
  await scenarioG_FullCloseWithLoss(users[6], FDUSD, THE, sol, backendSigner);

  // Scenario H — Activate + Open + Full Close + Deactivate
  // await scenarioH_DeactivatedPosition(users[7], FDUSD, THE, sol, backendSigner);

  // // Scenario I — Long == DSA (vFDUSD long, vSOL short)
  await scenarioI_LongEqualsDSA(users[8], FDUSD, sol, backendSigner);

  // // Scenario J — DSA == Short (vSOL long, vFDUSD short), loss close with DSA direct repay
  await scenarioJ_DSAEqualsShortWithLoss(users[9], FDUSD, sol, backendSigner);

  // // Scenario K — Long == DSA (vFDUSD long, vSOL short), 30% partial close, position stays open
  await scenarioK_LongEqualsDSAPartialClose(users[10], FDUSD, sol, backendSigner);

  console.log("\n=== Seed complete ===");
  console.log("User addresses for backend indexing:");
  const scenarioLabels = [
    "A (activate-only)",
    "B (opened)",
    "C (scaled)",
    "D (50% profit-close, no profit leg)",
    "E (100% profit-close)",
    "F (40% partial loss-close)",
    "G (100% loss-close)",
    "H (deactivated)",
    "I (long==DSA, vFDUSD/vSOL, 100% close)",
    "J (DSA==short, vSOL/vFDUSD, loss)",
    "K (long==DSA, vFDUSD/vSOL, 30% partial close)",
  ];
  users.forEach((u, i) => {
    console.log(`  ${u.address}  → Scenario ${scenarioLabels[i]}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
