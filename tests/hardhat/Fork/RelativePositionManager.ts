import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber, Wallet } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import {
  BinanceOracle__factory,
  ChainlinkOracle__factory,
  ComptrollerMock,
  ComptrollerMock__factory,
  IAccessControlManagerV8__factory,
  IERC20,
  IERC20__factory,
  IVToken,
  LeverageStrategiesManager,
  RelativePositionManager,
  ResilientOracleInterface__factory,
  SwapHelper,
  VBep20Interface__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

// --- Fork Flag ---
const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

// --- Mainnet constants (BSC) ---
const COMPTROLLER_ADDRESS = "0xfd36e2c2a6789db23113685031d7f16329158384";
const ACM_ADDRESS = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";

const SWAP_HELPER = "0xD79be25aEe798Aa34A9Ba1230003d7499be29A24";
const LEVERAGE_STRATEGIES_MANAGER = "0x03F079E809185a669Ca188676D0ADb09cbAd6dC1";

// Example markets: DSA, long, and short as three distinct tokens (same-token case can be added later)
const DSA_ADDRESS = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // USDC
const vDSA_ADDRESS = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8"; // vUSDC
const LONG_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"; // WBNB
const vLONG_ADDRESS = "0x6bCa74586218dB34cdB402295796b79663d816e9"; // vWBNB
const SHORT_ADDRESS = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8"; // ETH
const vSHORT_ADDRESS = "0xf508fCD89b8bd15579dc79A6827cB4686A3592c8"; // vETH

// A whale we can fund/impersonate
const DSA_WHALE = DSA_ADDRESS; // token itself holds large supply
// Real whale for SHORT (ETH) on BSC for liquidation tests (must hold underlying ETH)
const SHORT_WHALE_LIQUIDATION = "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3"; // Binance 8

// Chainlink oracle on BSC (used as main in ResilientOracle when manipulating price)
const CHAINLINK_ORACLE = "0x1B2103441A0A108daD8848D8F5d790e4D402921F";

let saltCounter = 0;

/**
 * Sets the oracle price for an asset by configuring ResilientOracle to use only Chainlink
 * as main (pivot/fallback zero) and calling setDirectPrice on the Chainlink oracle.
 * Uses NORMAL_TIMELOCK so must be called while impersonating timelock.
 * @param comptroller Comptroller (connected with timelock signer)
 * @param asset Underlying asset address (e.g. LONG_ADDRESS, DSA_ADDRESS)
 * @param price New price in 18 decimals (mantissa)
 */
async function setOraclePrice(comptroller: ComptrollerMock, asset: string, price: BigNumber): Promise<void> {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseEther("1"));
  const resilientOracleAddr = await comptroller.oracle();

  // Connect like Chainlink: ResilientOracle has setTokenConfig((address,address[3],bool[3],bool))
  const resilientOracle = new ethers.Contract(
    resilientOracleAddr,
    [
      "function setTokenConfig((address asset, address[3] oracles, bool[3] enableFlagsForOracles, bool cachingEnabled))",
    ],
    timelock,
  );

  await resilientOracle.setTokenConfig({
    asset,
    oracles: [CHAINLINK_ORACLE, ethers.constants.AddressZero, ethers.constants.AddressZero],
    enableFlagsForOracles: [true, false, false],
    cachingEnabled: false,
  });

  const chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK_ORACLE, timelock);
  await chainlinkOracle.setDirectPrice(asset, price);
}

async function getSwapData(
  tokenIn: string,
  tokenOut: string,
  exactAmountInMantissa: string,
  recipient: string,
  slippagePercentage: string,
): Promise<{ swapData: string; minAmountOut: BigNumber }> {
  const swapSignerWallet = new Wallet(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    ethers.provider,
  );
  const swapHelperContract = (await ethers.getContractAt("SwapHelper", SWAP_HELPER)) as SwapHelper;

  const swapHelperOwner = await swapHelperContract.owner();
  const impersonatedOwner = await initMainnetUser(swapHelperOwner, parseEther("1"));
  await swapHelperContract.connect(impersonatedOwner).setBackendSigner(swapSignerWallet.address);

  const domain = await swapHelperContract.eip712Domain();
  const network = await ethers.provider.getNetwork();
  const eip712Domain = {
    name: domain.name,
    version: domain.version,
    chainId: network.chainId,
    verifyingContract: domain.verifyingContract,
  };

  const TEN_YEARS_SECS = 10 * 365 * 24 * 60 * 60;
  const deadline = Math.floor(Date.now() / 1000) + TEN_YEARS_SECS;
  const amountIn = BigNumber.from(exactAmountInMantissa);

  const params = new URLSearchParams({
    chainId: "56",
    tokenInAddress: tokenIn,
    tokenOutAddress: tokenOut,
    slippagePercentage: slippagePercentage,
    recipientAddress: SWAP_HELPER,
    deadlineTimestampSecs: deadline.toString(),
    type: "exact-in",
    shouldTransferToReceiver: "false",
    exactAmountInMantissa: amountIn.toString(),
  });

  const res = await fetch(`https://api.venus.io/find-swap?${params}`);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Swap API error: ${res.status} - ${errorText}`);
  }
  const json = (await res.json()) as any;
  if (!json.quotes?.length) {
    console.log("Swap API response:", JSON.stringify(json, null, 2));
    throw new Error(`No API route found for ${tokenIn} -> ${tokenOut}`);
  }

  const quote = json.quotes[0];
  if (!quote.txs || quote.txs.length === 0) {
    throw new Error(`No swap transactions found in quote for ${tokenIn} -> ${tokenOut}`);
  }

  const swapHelperIface = swapHelperContract.interface;
  const calls: string[] = [];

  for (const tx of quote.txs) {
    if (!tx.target || !tx.data) {
      throw new Error(`Invalid tx in quote: ${JSON.stringify(tx)}`);
    }
    calls.push(swapHelperIface.encodeFunctionData("approveMax", [tokenIn, tx.target]));
    calls.push(swapHelperIface.encodeFunctionData("genericCall", [tx.target, tx.data]));
  }
  calls.push(swapHelperIface.encodeFunctionData("sweep", [tokenOut, recipient]));

  const salt = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["uint256"], [++saltCounter]));

  const types = {
    Multicall: [
      { name: "caller", type: "address" },
      { name: "calls", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  const value = { caller: recipient, calls, deadline, salt };
  const signature = await swapSignerWallet._signTypedData(eip712Domain, types, value);

  const multicallData = swapHelperIface.encodeFunctionData("multicall", [calls, deadline, salt, signature]);

  const quoteAmountOut = BigNumber.from(quote.amountOut);
  const slippageBps = parseFloat(slippagePercentage) * 10000;
  const minAmountOut = quoteAmountOut.mul(10000 - slippageBps).div(10000);

  return { swapData: multicallData, minAmountOut };
}

/**
 * Creates manipulated swap data for testing favorable/unfavorable price movements.
 * Instead of performing a real swap, this function directly transfers tokens to simulate
 * specific input/output amounts.
 *
 * @param tokenIn - Address of the token being sent to SwapHelper
 * @param tokenOut - Address of the token being received from SwapHelper
 * @param amountIn - Amount of tokenIn to send to SwapHelper
 * @param amountOut - Amount of tokenOut to receive from SwapHelper
 * @param recipient - Address to receive the output tokens
 * @param tokenOutWhaleOverride - Optional address to fund SwapHelper from (e.g. vToken holding underlying); defaults to tokenOut
 * @returns Encoded multicall data for the swap helper
 */
async function getManipulatedSwapData(
  tokenIn: string,
  tokenOut: string,
  amountIn: BigNumber,
  amountOut: BigNumber,
  recipient: string,
  tokenOutWhaleOverride?: string,
): Promise<string> {
  const swapSignerWallet = new Wallet(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    ethers.provider,
  );
  const swapHelperContract = (await ethers.getContractAt("SwapHelper", SWAP_HELPER)) as SwapHelper;

  const swapHelperOwner = await swapHelperContract.owner();
  const impersonatedOwner = await initMainnetUser(swapHelperOwner, parseEther("1"));
  await swapHelperContract.connect(impersonatedOwner).setBackendSigner(swapSignerWallet.address);

  const domain = await swapHelperContract.eip712Domain();
  const network = await ethers.provider.getNetwork();
  const eip712Domain = {
    name: domain.name,
    version: domain.version,
    chainId: network.chainId,
    verifyingContract: domain.verifyingContract,
  };

  const TEN_YEARS_SECS = 10 * 365 * 24 * 60 * 60;
  const deadline = Math.floor(Date.now() / 1000) + TEN_YEARS_SECS;

  // Fund the SwapHelper with tokenOut so it can transfer to recipient
  const tokenOutContract = IERC20__factory.connect(tokenOut, ethers.provider);
  const tokenOutWhale = tokenOutWhaleOverride ?? tokenOut;
  const whaleSigner = await initMainnetUser(tokenOutWhale, parseEther("1"));
  await tokenOutContract.connect(whaleSigner).transfer(SWAP_HELPER, amountOut);

  // Encode a simple transfer call instead of a real swap
  // The SwapHelper will receive tokenIn from the caller and transfer tokenOut to recipient
  const tokenOutIface = new ethers.utils.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  const transferCalldata = tokenOutIface.encodeFunctionData("transfer", [recipient, amountOut]);

  const swapHelperIface = swapHelperContract.interface;
  const calls: string[] = [];

  // Generic call to transfer tokenOut to recipient
  calls.push(swapHelperIface.encodeFunctionData("genericCall", [tokenOut, transferCalldata]));

  const salt = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["uint256"], [++saltCounter]));

  const types = {
    Multicall: [
      { name: "caller", type: "address" },
      { name: "calls", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  const value = { caller: recipient, calls, deadline, salt };
  const signature = await swapSignerWallet._signTypedData(eip712Domain, types, value);

  return swapHelperIface.encodeFunctionData("multicall", [calls, deadline, salt, signature]);
}

async function setMaxStalePeriod() {
  const REDSTONE = "0x8455EFA4D7Ff63b8BFD96AdD889483Ea7d39B70a";
  const CHAINLINK = "0x1B2103441A0A108daD8848D8F5d790e4D402921F";
  const BINANCE = "0x594810b741d136f1960141C0d8Fb4a91bE78A820";
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("2"));

  const redStoneOracle = ChainlinkOracle__factory.connect(REDSTONE, timelock);
  const chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK, timelock);
  const binanceOracle = BinanceOracle__factory.connect(BINANCE, timelock);

  const ONE_YEAR = "31536000";

  // Token configurations: [asset, redstoneFeed, chainlinkFeed, binanceSymbol]
  const tokens = [
    {
      name: "USDC (DSA)",
      asset: DSA_ADDRESS,
      redstoneFeed: "0xeA2511205b959548459A01e358E0A30424dc0B70",
      chainlinkFeed: "0x51597f405303C4377E36123cBc172b13269EA163",
      binanceSymbol: "USDC",
    },
    {
      name: "WBNB (LONG)",
      asset: LONG_ADDRESS,
      redstoneFeed: "0x8dd2D85C7c28F43F965AE4d9545189C7D022ED0e",
      chainlinkFeed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
      binanceSymbol: "WBNB",
    },
    {
      name: "ETH (SHORT)",
      asset: SHORT_ADDRESS,
      redstoneFeed: "0x9cF19D284862A66378c304ACAcB0E857EBc3F856",
      chainlinkFeed: "0xe48a5Fd74d4A5524D76960ef3B52204C0e11fCD1",
      binanceSymbol: "ETH",
    },
  ];

  // Configure all tokens
  for (const token of tokens) {
    // RedStone Oracle
    if (token.redstoneFeed !== "0x0000000000000000000000000000000000000000") {
      await redStoneOracle.setTokenConfig({
        asset: token.asset,
        feed: token.redstoneFeed,
        maxStalePeriod: ONE_YEAR,
      });
    }

    // Chainlink Oracle
    if (token.chainlinkFeed !== "0x0000000000000000000000000000000000000000") {
      await chainlinkOracle.setTokenConfig({
        asset: token.asset,
        feed: token.chainlinkFeed,
        maxStalePeriod: ONE_YEAR,
      });
    }

    // Binance Oracle
    await binanceOracle.setMaxStalePeriod(token.binanceSymbol, ONE_YEAR);
  }

  // BNB (for wrapped/unwrapped compatibility)
  await binanceOracle.setMaxStalePeriod("BNB", ONE_YEAR);
}

// --- Forked RPM setup ---

type RpmForkFixture = {
  rpm: RelativePositionManager;
  comptroller: ComptrollerMock;
  leverageManager: LeverageStrategiesManager;
  dsa: IERC20;
  long: IERC20;
  short: IERC20;
  longVToken: IVToken;
  shortVToken: IVToken;
  dsaVToken: IVToken;
};

async function setupRpmForkFixture(): Promise<RpmForkFixture> {
  const [deployer] = await ethers.getSigners();
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseEther("1"));

  const comptroller = await ComptrollerMock__factory.connect(COMPTROLLER_ADDRESS, timelock);

  const leverageManager = (await ethers.getContractAt(
    "LeverageStrategiesManager",
    LEVERAGE_STRATEGIES_MANAGER,
  )) as LeverageStrategiesManager;

  const RPMFactory = await ethers.getContractFactory("RelativePositionManager");
  const rpm = (await upgrades.deployProxy(RPMFactory, [ACM_ADDRESS], {
    constructorArgs: [comptroller.address, leverageManager.address],
    initializer: "initialize",
    unsafeAllow: ["state-variable-immutable"],
  })) as RelativePositionManager;

  // Grant deployer permission to call admin functions on our new RPM (mainnet ACM has no entry for this address)
  const acm = IAccessControlManagerV8__factory.connect(ACM_ADDRESS, timelock);
  await acm.giveCallPermission(rpm.address, "setPositionAccountImplementation(address)", deployer.address);
  await acm.giveCallPermission(rpm.address, "addDSAVToken(address)", deployer.address);

  // Set PositionAccount implementation as in unit tests
  const PositionAccountFactory = await ethers.getContractFactory("PositionAccount");
  const positionAccountImpl = await PositionAccountFactory.deploy(
    comptroller.address,
    rpm.address,
    leverageManager.address,
  );
  await rpm.setPositionAccountImplementation(positionAccountImpl.address);

  const dsa = IERC20__factory.connect(DSA_ADDRESS, deployer) as IERC20;
  const long = IERC20__factory.connect(LONG_ADDRESS, deployer) as IERC20;
  const short = IERC20__factory.connect(SHORT_ADDRESS, deployer) as IERC20;
  const longVToken = (await ethers.getContractAt("IVToken", vLONG_ADDRESS)) as IVToken;
  const shortVToken = (await ethers.getContractAt("IVToken", vSHORT_ADDRESS)) as IVToken;
  const dsaVToken = (await ethers.getContractAt("IVToken", vDSA_ADDRESS)) as IVToken;

  // Configure DSA in RPM
  await rpm.connect(deployer).addDSAVToken(vDSA_ADDRESS);

  return { rpm, comptroller, leverageManager, dsa, long, short, longVToken, shortVToken, dsaVToken };
}

// --- Tests ---
if (FORK_MAINNET) {
  forking(83526337, () => {
    let rpm: RelativePositionManager;
    let comptroller: ComptrollerMock;
    let dsa: IERC20;
    let long: IERC20;
    let short: IERC20;
    let longVToken: IVToken;
    let shortVToken: IVToken;
    let dsaVToken: IVToken;
    let leverageManager: LeverageStrategiesManager;
    let alice: any;

    describe("RelativePositionManager forked flows", async function () {
      this.timeout(720000); // 12 minutes

      before(async function () {
        await setMaxStalePeriod();
      });

      beforeEach(async () => {
        ({ rpm, comptroller, dsa, long, short, longVToken, shortVToken, leverageManager, dsaVToken } =
          await loadFixture(setupRpmForkFixture));
        [, alice] = await ethers.getSigners();
      });

      /**
       * Shared helper: funds Alice, activates a position, opens it with manipulated swap data,
       * records and validates the post-open state, and returns key values for further test steps.
       */
      async function activateAndOpenPosition(params: {
        initialPrincipal: BigNumber;
        shortAmount: BigNumber;
        longAmount: BigNumber;
        leverage: BigNumber;
        useLongVToken?: IVToken;
        longAddress?: string;
        tokenOutWhaleOverride?: string;
        accrueAfterOpen?: boolean;
      }): Promise<{
        positionAccount: string;
        shortDebtAfterOpen: BigNumber;
        longBalanceAfterOpen: BigNumber;
        effectiveLongVToken: IVToken;
      }> {
        const effectiveLongVToken = params.useLongVToken ?? longVToken;
        const effectiveLongAddress = params.longAddress ?? LONG_ADDRESS;

        // Fund Alice with DSA tokens
        const whaleSigner = await initMainnetUser(DSA_WHALE, parseEther("1"));
        await dsa.connect(whaleSigner).transfer(alice.address, params.initialPrincipal);
        await dsa.connect(alice).approve(rpm.address, params.initialPrincipal);

        // Activate + Open Position (Combined)
        const minLong = params.longAmount.mul(98).div(100);
        const openSwapData = await getManipulatedSwapData(
          SHORT_ADDRESS,
          effectiveLongAddress,
          params.shortAmount,
          params.longAmount,
          leverageManager.address,
          params.tokenOutWhaleOverride,
        );

        await rpm
          .connect(alice)
          .activateAndOpenPosition(
            effectiveLongVToken.address,
            shortVToken.address,
            0,
            params.initialPrincipal,
            params.leverage,
            params.shortAmount,
            minLong,
            openSwapData,
          );

        const position = await rpm.getPosition(alice.address, effectiveLongVToken.address, shortVToken.address);
        const positionAccount = position.positionAccount;
        expect(position.isActive).to.eq(true, "Position should be active after activation");

        if (params.accrueAfterOpen) {
          await effectiveLongVToken.connect(alice).accrueInterest();
          await shortVToken.connect(alice).accrueInterest();
        }

        const shortDebtAfterOpen = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
        const longBalanceAfterOpen = await rpm.callStatic.getLongCollateralBalance(
          alice.address,
          effectiveLongVToken.address,
          shortVToken.address,
        );

        // Basic validations
        const shortDebtTolerance = params.shortAmount.mul(1).div(10000);
        expect(shortDebtAfterOpen).to.be.closeTo(params.shortAmount, shortDebtTolerance as any);
        expect(longBalanceAfterOpen).to.be.gte(
          params.longAmount.mul(98).div(100),
          "Long balance should be >= minimum amount out",
        );

        const positionAfterOpen = await rpm.getPosition(
          alice.address,
          effectiveLongVToken.address,
          shortVToken.address,
        );
        expect(positionAfterOpen.isActive).to.eq(true, "Position should be active after opening");

        return { positionAccount, shortDebtAfterOpen, longBalanceAfterOpen, effectiveLongVToken };
      }

      describe("no price deviation (slippage only)", () => {
        it("open + partial close with profit (three distinct tokens)", async () => {
          const INITIAL_PRINCIPAL = parseEther("10000");
          const SHORT_AMOUNT = parseEther("5");
          const leverage = parseEther("2");
          const closeFractionBps = 3000; // Close 30% of position

          // ========================================
          // SETUP: Fund Alice with DSA tokens
          // ========================================
          const whaleSigner = await initMainnetUser(DSA_WHALE, parseEther("1"));
          await dsa.connect(whaleSigner).transfer(alice.address, INITIAL_PRINCIPAL);
          await dsa.connect(alice).approve(rpm.address, INITIAL_PRINCIPAL);

          // ========================================
          // STEP 1: Activate + Open Position (Combined)
          // ========================================
          const { swapData: openSwapData, minAmountOut: minLong } = await getSwapData(
            SHORT_ADDRESS,
            LONG_ADDRESS,
            SHORT_AMOUNT.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          await rpm
            .connect(alice)
            .activateAndOpenPosition(
              longVToken.address,
              shortVToken.address,
              0,
              INITIAL_PRINCIPAL,
              leverage,
              SHORT_AMOUNT,
              minLong,
              openSwapData,
            );

          const position = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          const positionAccount = position.positionAccount;

          // VALIDATION: Verify position is active after activation
          expect(position.isActive).to.eq(true, "Position should be active after activation");

          // Record state after opening position
          const shortDebtAfterOpen = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterOpen = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate position was opened successfully

          // VALIDATION 1: Verify short debt matches borrowed amount (within 1% tolerance for interest accumulated)
          const shortDebtTolerance = SHORT_AMOUNT.mul(1).div(100);
          expect(shortDebtAfterOpen).to.be.closeTo(SHORT_AMOUNT, shortDebtTolerance as any);

          // VALIDATION 2: Verify long balance meets or exceeds the minimum amount out from swap (within 2% tolerance for fees)
          const longBalanceTolerance = minLong.mul(1).div(100); // 1% tolerance for slippage
          expect(longBalanceAfterOpen).to.be.gte(minLong, longBalanceTolerance as any);

          // VALIDATION 3: Verify position is active
          const positionAfterOpen = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterOpen.isActive).to.eq(true, "Position should be active after opening");

          // ========================================
          // STEP 3: Partial Close with Profit (30%)
          // ========================================

          // Calculate expected amounts based on close fraction
          const expectedLongToRedeem = longBalanceAfterOpen.mul(closeFractionBps).div(10000);
          const expectedShortToRepay = shortDebtAfterOpen.mul(closeFractionBps).div(10000);

          // Add slippage tolerance for long redemption (1% extra)
          const longToRedeem = expectedLongToRedeem.mul(101).div(100);

          // Add interest buffer for repay (0.1% buffer to account for accrual during execution)
          const minRepay = expectedShortToRepay.mul(1001).div(1000);

          // Get swap data for closing (LONG → SHORT)
          const { swapData: repaySwapData } = await getSwapData(
            LONG_ADDRESS,
            SHORT_ADDRESS,
            longToRedeem.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          // Execute partial close (all long goes to repay, no explicit profit swap)
          await rpm.connect(alice).closeWithProfit(
            longVToken.address,
            shortVToken.address,
            closeFractionBps,
            longToRedeem, // Amount to redeem for repay
            minRepay,
            repaySwapData,
            0, // No profit amount
            0, // No min profit
            "0x", // No profit swap data
          );

          // ========================================
          // VALIDATION: Verify Final State
          // ========================================

          // Get final balances
          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          // Calculate actual changes
          const actualShortRepaid = shortDebtAfterOpen.sub(shortDebtAfterClose);
          const actualLongRedeemed = longBalanceAfterOpen.sub(longBalanceAfterClose);

          // Verify position is still active (partial close)
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true, "Position should remain active after partial close");

          // MAIN VALIDATION 1: Verify exact long redemption amount matches function argument
          const longRedeemTolerance = longToRedeem.mul(2).div(100); // 2% tolerance
          expect(actualLongRedeemed).to.be.closeTo(longToRedeem, longRedeemTolerance as any);

          // MAIN VALIDATION 2: Verify at least 50% of short debt was repaid
          const shortRepaidTolerance = expectedShortToRepay.mul(2).div(100); // 2% tolerance
          expect(actualShortRepaid).to.be.closeTo(expectedShortToRepay, shortRepaidTolerance as any);

          // Verify remaining balances are approximately (1 - closeFractionBps) of the initial amounts (within 2% tolerance)
          const expectedRemainingShortDebt = shortDebtAfterOpen.mul(10000 - closeFractionBps).div(10000);
          const expectedRemainingLongBalance = longBalanceAfterOpen.mul(10000 - closeFractionBps).div(10000);

          const remainingShortTolerance = expectedRemainingShortDebt.mul(2).div(100); // 2% tolerance
          expect(shortDebtAfterClose).to.be.closeTo(expectedRemainingShortDebt, remainingShortTolerance as any);

          const remainingLongTolerance = expectedRemainingLongBalance.mul(2).div(100); // 2% tolerance
          expect(longBalanceAfterClose).to.be.closeTo(expectedRemainingLongBalance, remainingLongTolerance as any);

          // Verify debt and collateral are still positive (partial close, not full close)
          expect(shortDebtAfterClose).to.be.gt(0, "Short debt should be > 0 after partial close");
          expect(longBalanceAfterClose).to.be.gt(0, "Long balance should be > 0 after partial close");
        });

        it("open + full close (100% - three distinct tokens)", async () => {
          const INITIAL_PRINCIPAL = parseEther("10000");
          const SHORT_AMOUNT = parseEther("5");
          const leverage = parseEther("2");
          const closeFractionBps = 10000; // Close 100% of position (full close)

          // ========================================
          // SETUP: Fund Alice with DSA tokens
          // ========================================
          const whaleSigner = await initMainnetUser(DSA_WHALE, parseEther("1"));
          await dsa.connect(whaleSigner).transfer(alice.address, INITIAL_PRINCIPAL);
          await dsa.connect(alice).approve(rpm.address, INITIAL_PRINCIPAL);

          // ========================================
          // STEP 1: Activate + Open Position (Combined)
          // ========================================
          const { swapData: openSwapData, minAmountOut: minLong } = await getSwapData(
            SHORT_ADDRESS,
            LONG_ADDRESS,
            SHORT_AMOUNT.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          await rpm
            .connect(alice)
            .activateAndOpenPosition(
              longVToken.address,
              shortVToken.address,
              0,
              INITIAL_PRINCIPAL,
              leverage,
              SHORT_AMOUNT,
              minLong,
              openSwapData,
            );

          const position = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          const positionAccount = position.positionAccount;

          // VALIDATION: Verify position is active after activation
          expect(position.isActive).to.eq(true, "Position should be active after activation");

          // Record state after opening position
          const shortDebtAfterOpen = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterOpen = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate position was opened successfully
          const shortDebtTolerance = SHORT_AMOUNT.mul(1).div(100);
          expect(shortDebtAfterOpen).to.be.closeTo(SHORT_AMOUNT, shortDebtTolerance as any);

          const longBalanceTolerance = minLong.mul(2).div(100); // 2% tolerance for slippage
          expect(longBalanceAfterOpen).to.be.gte(minLong, longBalanceTolerance as any);

          const positionAfterOpen = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterOpen.isActive).to.eq(true, "Position should be active after opening");

          // ========================================
          // STEP 3: Full Close with Loss (100%)
          // ========================================

          // Calculate expected amounts for full close
          const expectedLongToRedeem = longBalanceAfterOpen;
          const expectedShortToRepay = shortDebtAfterOpen;

          // Get quote for LONG → SHORT to estimate how much we'll get
          const { swapData: firstSwapData, minAmountOut: minShortFromLongSwap } = await getSwapData(
            LONG_ADDRESS,
            SHORT_ADDRESS,
            expectedLongToRedeem.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          // Calculate shortfall based on expectedShortToRepay (not buffered)
          // The contract will add the tolerance buffer internally for 100% closes
          const shortfall = expectedShortToRepay.sub(minShortFromLongSwap);

          // Step 1: Get quote for SHORT → DSA to find how much DSA covers the shortfall
          const { minAmountOut: dsaEstimate } = await getSwapData(
            SHORT_ADDRESS,
            DSA_ADDRESS,
            shortfall.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          // Step 2: Add 5% buffer to the DSA estimate, then get DSA → SHORT swap data
          const dsaAmountToSwap = dsaEstimate.mul(105).div(100);

          const { swapData: secondSwapData, minAmountOut: minShortFromDsaSwap } = await getSwapData(
            DSA_ADDRESS,
            SHORT_ADDRESS,
            dsaAmountToSwap.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          // Execute full close with loss (use DSA to cover shortfall)
          await rpm.connect(alice).closeWithLoss(
            longVToken.address,
            shortVToken.address,
            closeFractionBps,
            expectedLongToRedeem, // Amount of LONG to redeem for first swap
            minShortFromLongSwap, // Amount of SHORT to repay from first swap
            minShortFromLongSwap, // Min amount out from first swap
            firstSwapData,
            dsaAmountToSwap, // DSA amount to redeem for second swap (calculated to ensure enough SHORT)
            minShortFromDsaSwap, // Min amount out from second swap
            secondSwapData,
          );

          // ========================================
          // VALIDATION: Verify Final State
          // ========================================

          // Get final balances
          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          // Calculate actual changes
          const actualShortRepaid = shortDebtAfterOpen.sub(shortDebtAfterClose);
          const actualLongRedeemed = longBalanceAfterOpen.sub(longBalanceAfterClose);

          // Position remains active after close — deactivation requires an explicit deactivate call
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true, "Position should remain active until explicitly deactivated");

          // MAIN VALIDATION 1: Verify all long was redeemed
          const longRedeemTolerance = expectedLongToRedeem.mul(2).div(100); // 2% tolerance
          expect(actualLongRedeemed).to.be.closeTo(expectedLongToRedeem, longRedeemTolerance as any);

          // MAIN VALIDATION 2: Verify all short debt was repaid
          const shortRepaidTolerance = expectedShortToRepay.mul(2).div(100); // 2% tolerance
          expect(actualShortRepaid).to.be.closeTo(expectedShortToRepay, shortRepaidTolerance as any);

          // Verify balances are exactly zero after full close
          expect(shortDebtAfterClose).to.eq(0, "Short debt should be 0 after full close");
          expect(longBalanceAfterClose).to.eq(0, "Long balance should be 0 after full close");
        });
      });

      describe("unfavorable price deviation (loss scenarios)", () => {
        it("partial close with loss from price movement", async () => {
          const INITIAL_PRINCIPAL = parseEther("10000");
          const SHORT_AMOUNT = parseEther("5");
          const leverage = parseEther("2");
          const closeFractionBps = 5000; // Close 50% of position

          // ========================================
          // SETUP: Fund Alice with DSA tokens
          // ========================================
          const whaleSigner = await initMainnetUser(DSA_WHALE, parseEther("1"));
          await dsa.connect(whaleSigner).transfer(alice.address, INITIAL_PRINCIPAL);
          await dsa.connect(alice).approve(rpm.address, INITIAL_PRINCIPAL);

          // ========================================
          // STEP 1: Activate + Open Position (Combined)
          // ========================================
          const { swapData: openSwapData, minAmountOut: minLong } = await getSwapData(
            SHORT_ADDRESS,
            LONG_ADDRESS,
            SHORT_AMOUNT.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          await rpm
            .connect(alice)
            .activateAndOpenPosition(
              longVToken.address,
              shortVToken.address,
              0,
              INITIAL_PRINCIPAL,
              leverage,
              SHORT_AMOUNT,
              minLong,
              openSwapData,
            );

          const position = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          const positionAccount = position.positionAccount;

          // VALIDATION: Verify position is active after activation
          expect(position.isActive).to.eq(true, "Position should be active after activation");

          // Record state after opening position
          const shortDebtAfterOpen = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterOpen = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate position was opened successfully
          // VALIDATION 1: Verify short debt matches borrowed amount (within 0.01% tolerance for interest)
          const shortDebtTolerance = SHORT_AMOUNT.mul(1).div(10000); // 0.01% tolerance
          expect(shortDebtAfterOpen).to.be.closeTo(SHORT_AMOUNT, shortDebtTolerance as any);

          // VALIDATION 2: Verify long balance meets or exceeds the minimum amount out from swap
          expect(longBalanceAfterOpen).to.be.gte(minLong, "Long balance should be >= minimum amount out");

          // ========================================
          // STEP 3: Simulate Unfavorable Price Movement
          // ========================================

          // Calculate expected amounts based on close fraction
          const expectedLongToRedeem = longBalanceAfterOpen.mul(closeFractionBps).div(10000);
          const expectedShortToRepay = shortDebtAfterOpen.mul(closeFractionBps).div(10000);

          // Add buffer for long redemption (1% slippage protection)
          const longToRedeem = expectedLongToRedeem.mul(101).div(100);

          // Simulate 15% loss: LONG price decreased, so we get 15% less SHORT than needed
          const shortAmountAfterLongSwap = expectedShortToRepay.mul(85).div(100);
          const shortfall = expectedShortToRepay.sub(shortAmountAfterLongSwap);

          // Get manipulated swap data for first swap (LONG → SHORT with 15% loss)
          const firstSwapData = await getManipulatedSwapData(
            LONG_ADDRESS,
            SHORT_ADDRESS,
            longToRedeem, // longAmountToRedeemForFirstSwap
            shortAmountAfterLongSwap, // shortAmountToRepayForFirstSwap
            leverageManager.address,
          );

          // For manipulated swap, we can use any reasonable DSA input amount
          // Pick 20% of initial principal to repay the loss
          const dsaAmountToSwap = INITIAL_PRINCIPAL.mul(20).div(100);

          // Add buffer to second swap output to cover any rounding/interest accrual
          // Need to output more than the exact shortfall to pass validation
          const shortAmountFromDsaSwap = shortfall.mul(1002).div(1000); // 0.2% buffer

          // Get manipulated swap data for second swap (DSA → SHORT to cover shortfall)
          const secondSwapData = await getManipulatedSwapData(
            DSA_ADDRESS,
            SHORT_ADDRESS,
            dsaAmountToSwap, // dsaAmountToRedeemForSecondSwap
            shortAmountFromDsaSwap, // shortAmountToRepayForSecondSwap
            leverageManager.address,
          );

          // Record alice's SHORT balance before close to check dust transfer
          const aliceShortBalanceBefore = await short.balanceOf(alice.address);

          // Execute partial close with loss
          await rpm.connect(alice).closeWithLoss(
            longVToken.address,
            shortVToken.address,
            closeFractionBps,
            longToRedeem,
            shortAmountAfterLongSwap, // Amount we actually get from first swap (not expectedShortToRepay)
            shortAmountAfterLongSwap, // Min amount out from first swap (same as above needs to be different when flashLoan fee applies)
            firstSwapData,
            dsaAmountToSwap,
            shortAmountFromDsaSwap,
            secondSwapData,
          );

          // ========================================
          // VALIDATION: Verify Final State
          // ========================================

          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const aliceShortBalanceAfter = await short.balanceOf(alice.address);

          // Verify ~50% of debt was repaid
          const actualShortRepaid = shortDebtAfterOpen.sub(shortDebtAfterClose);
          const shortRepaidTolerance = expectedShortToRepay.mul(1).div(10000); // 0.01% tolerance
          expect(actualShortRepaid).to.be.closeTo(expectedShortToRepay, shortRepaidTolerance as any);

          // Verify ~50% of long was redeemed
          const actualLongRedeemed = longBalanceAfterOpen.sub(longBalanceAfterClose);
          const longRedeemTolerance = longToRedeem.mul(1).div(10000); // 0.01% tolerance
          expect(actualLongRedeemed).to.be.closeTo(longToRedeem, longRedeemTolerance as any);

          // Verify dust (excess SHORT from second swap) was transferred to alice
          const dustReceived = aliceShortBalanceAfter.sub(aliceShortBalanceBefore);
          const expectedDust = shortAmountFromDsaSwap.sub(shortfall);
          expect(dustReceived).to.be.gte(0, "Alice should receive dust from excess swap output");
          // Allow some tolerance for dust amount as contract may consume some for interest
          expect(dustReceived).to.be.lte(expectedDust, "Dust should not exceed expected amount");

          // Position remains active after partial close
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true);
        });

        it("full close with loss from price movement", async () => {
          const INITIAL_PRINCIPAL = parseEther("15000");
          const SHORT_AMOUNT = parseEther("3");
          const leverage = parseEther("3");
          const closeFractionBps = 10000; // Full close

          // ========================================
          // SETUP: Fund Alice with DSA tokens
          // ========================================
          const whaleSigner = await initMainnetUser(DSA_WHALE, parseEther("1"));
          await dsa.connect(whaleSigner).transfer(alice.address, INITIAL_PRINCIPAL);
          await dsa.connect(alice).approve(rpm.address, INITIAL_PRINCIPAL);

          // ========================================
          // STEP 1: Activate + Open Position (Combined)
          // ========================================
          const { swapData: openSwapData, minAmountOut: minLong } = await getSwapData(
            SHORT_ADDRESS,
            LONG_ADDRESS,
            SHORT_AMOUNT.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          await rpm
            .connect(alice)
            .activateAndOpenPosition(
              longVToken.address,
              shortVToken.address,
              0,
              INITIAL_PRINCIPAL,
              leverage,
              SHORT_AMOUNT,
              minLong,
              openSwapData,
            );

          const position = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          const positionAccount = position.positionAccount;

          // VALIDATION: Verify position is active after activation
          expect(position.isActive).to.eq(true, "Position should be active after activation");

          // Record state after opening position
          const shortDebtAfterOpen = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterOpen = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate position was opened successfully
          // VALIDATION 1: Verify short debt matches borrowed amount (within 0.01% tolerance for interest)
          const shortDebtTolerance = SHORT_AMOUNT.mul(1).div(10000); // 0.01% tolerance
          expect(shortDebtAfterOpen).to.be.closeTo(SHORT_AMOUNT, shortDebtTolerance as any);

          // VALIDATION 2: Verify long balance meets or exceeds the minimum amount out from swap
          expect(longBalanceAfterOpen).to.be.gte(minLong, "Long balance should be >= minimum amount out");

          // ========================================
          // STEP 3: Simulate Unfavorable Price Movement
          // ========================================

          const expectedLongToRedeem = longBalanceAfterOpen;
          const expectedShortToRepay = shortDebtAfterOpen;

          // Simulate 20% loss: LONG price decreased, so we get 20% less SHORT than needed
          const shortAmountAfterLongSwap = expectedShortToRepay.mul(80).div(100);
          const shortfall = expectedShortToRepay.sub(shortAmountAfterLongSwap);

          // Get manipulated swap data for first swap (LONG → SHORT with 20% loss)
          const firstSwapData = await getManipulatedSwapData(
            LONG_ADDRESS,
            SHORT_ADDRESS,
            expectedLongToRedeem,
            shortAmountAfterLongSwap,
            leverageManager.address,
          );

          // For manipulated swap, we can use any reasonable DSA input amount
          // Pick 25% of initial principal as arbitrary input amount (slightly more for full close)
          const dsaAmountToSwap = INITIAL_PRINCIPAL.mul(25).div(100);

          // Add buffer to second swap output to cover any rounding/interest accrual
          // For full close (100%), contract adds 2% tolerance, we add 0.2% for interest = 2.2% total
          const shortAmountFromDsaSwap = shortfall.mul(1022).div(1000); // 2.2% buffer

          // Get manipulated swap data for second swap (DSA → SHORT to cover shortfall)
          const secondSwapData = await getManipulatedSwapData(
            DSA_ADDRESS,
            SHORT_ADDRESS,
            dsaAmountToSwap,
            shortAmountFromDsaSwap, // Output with buffer (extra would be transferred back to the user as dust)
            leverageManager.address,
          );

          // Record alice's SHORT balance before close to check dust transfer
          const aliceShortBalanceBefore = await short.balanceOf(alice.address);

          // Execute full close with loss
          await rpm.connect(alice).closeWithLoss(
            longVToken.address,
            shortVToken.address,
            closeFractionBps,
            expectedLongToRedeem,
            shortAmountAfterLongSwap,
            shortAmountAfterLongSwap, // Min amount out from first swap
            firstSwapData,
            dsaAmountToSwap,
            shortAmountFromDsaSwap, // Min amount out: use actual swap output (which has buffer)
            secondSwapData,
          );

          // ========================================
          // VALIDATION: Verify Final State
          // ========================================

          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const aliceShortBalanceAfter = await short.balanceOf(alice.address);

          // Verify all debt was repaid
          expect(shortDebtAfterClose).to.eq(0, "Short debt should be 0 after full close");

          // Verify all long was redeemed
          expect(longBalanceAfterClose).to.eq(0, "Long balance should be 0 after full close");

          // Verify dust (excess SHORT from second swap) was transferred to alice
          const dustReceived = aliceShortBalanceAfter.sub(aliceShortBalanceBefore);
          const expectedDust = shortAmountFromDsaSwap.sub(shortfall);
          expect(dustReceived).to.be.gte(0, "Alice should receive dust from excess swap output");
          // Allow some tolerance for dust amount as contract may consume some for interest
          expect(dustReceived).to.be.lte(expectedDust, "Dust should not exceed expected amount");

          // Position remains active (requires explicit deactivation)
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true);
        });
      });

      describe("favorable price deviation", () => {
        it("partial close with profit from price movement", async () => {
          const INITIAL_PRINCIPAL = parseEther("9000");
          const SHORT_AMOUNT = parseEther("4");
          const leverage = parseEther("1.5");
          const closeFractionBps = 6000; // Close 60% of position

          // ========================================
          // SETUP: Fund Alice with DSA tokens
          // ========================================
          const whaleSigner = await initMainnetUser(DSA_WHALE, parseEther("1"));
          await dsa.connect(whaleSigner).transfer(alice.address, INITIAL_PRINCIPAL);
          await dsa.connect(alice).approve(rpm.address, INITIAL_PRINCIPAL);

          // ========================================
          // STEP 1: Activate + Open Position (Combined)
          // ========================================
          const { swapData: openSwapData, minAmountOut: minLong } = await getSwapData(
            SHORT_ADDRESS,
            LONG_ADDRESS,
            SHORT_AMOUNT.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          await rpm
            .connect(alice)
            .activateAndOpenPosition(
              longVToken.address,
              shortVToken.address,
              0,
              INITIAL_PRINCIPAL,
              leverage,
              SHORT_AMOUNT,
              minLong,
              openSwapData,
            );

          const position = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          const positionAccount = position.positionAccount;

          // VALIDATION: Verify position is active after activation
          expect(position.isActive).to.eq(true, "Position should be active after activation");

          // Record state after opening position
          const shortDebtAfterOpen = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterOpen = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate position was opened successfully
          // VALIDATION 1: Verify short debt matches borrowed amount (within 0.01% tolerance for interest)
          const shortDebtTolerance = SHORT_AMOUNT.mul(1).div(10000); // 0.01% tolerance
          expect(shortDebtAfterOpen).to.be.closeTo(SHORT_AMOUNT, shortDebtTolerance as any);

          // VALIDATION 2: Verify long balance meets or exceeds the minimum amount out from swap
          expect(longBalanceAfterOpen).to.be.gte(minLong, "Long balance should be >= minimum amount out");

          // ========================================
          // STEP 3: Simulate Favorable Price Movement
          // ========================================

          // Calculate expected amounts based on close fraction
          const expectedLongToRedeem = longBalanceAfterOpen.mul(closeFractionBps).div(10000);
          const expectedShortToRepay = shortDebtAfterOpen.mul(closeFractionBps).div(10000);

          // Simulate 20% favorable price: we can use less LONG to get the needed SHORT
          // Split LONG: 80% for repay (due to favorable price), 20% for profit
          const longForRepay = expectedLongToRedeem.mul(80).div(100);
          const longForProfit = expectedLongToRedeem.sub(longForRepay);

          // Add small buffer to swap output to account for interest accrual
          const shortAmountFromRepaySwap = expectedShortToRepay.mul(1002).div(1000); // 0.2% buffer

          // Repay swap outputs SHORT with buffer for interest
          const repaySwapData = await getManipulatedSwapData(
            LONG_ADDRESS,
            SHORT_ADDRESS,
            longForRepay,
            shortAmountFromRepaySwap, // With buffer for interest
            leverageManager.address,
          );

          // Estimate how much DSA we'll get from profit LONG
          // LONG is WBNB (~$500), DSA is USDC (~$1), so 1 LONG ~= 500 DSA
          const estimatedProfitInDsa = longForProfit.mul(500); // Rough estimate: 1 LONG ~= 500 DSA

          // Get manipulated swap data for profit conversion (LONG → DSA)
          // Recipient is RPM contract - _performSwap expects tokens to return to RPM directly
          const profitSwapData = await getManipulatedSwapData(
            LONG_ADDRESS,
            DSA_ADDRESS,
            longForProfit,
            estimatedProfitInDsa,
            rpm.address, // RPM performs swap and expects DSA back to itself
          );

          // Record underlying DSA balance in position account (in DSA market) before close
          const dsaVToken = (await ethers.getContractAt("IVToken", vDSA_ADDRESS)) as IVToken;
          const dsaUnderlyingBefore = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);

          // Execute partial close with profit
          // Use same buffer for minAmountOutRepay to pass validation
          const minAmountOutRepay = shortAmountFromRepaySwap; // Same as swap output

          await rpm.connect(alice).closeWithProfit(
            longVToken.address,
            shortVToken.address,
            closeFractionBps,
            longForRepay, // longAmountToRedeemForRepay
            minAmountOutRepay, // minAmountOutRepay (with 0.2% buffer for interest)
            repaySwapData, // swapDataRepay
            longForProfit, // longAmountToRedeemForProfit
            estimatedProfitInDsa.mul(98).div(100), // minAmountOutProfit
            profitSwapData, // swapDataProfit
          );

          // ========================================
          // VALIDATION: Verify Final State
          // ========================================

          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const dsaUnderlyingAfter = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);

          // Verify ~50% of debt was repaid
          const actualShortRepaid = shortDebtAfterOpen.sub(shortDebtAfterClose);
          const shortRepaidTolerance = expectedShortToRepay.mul(1).div(10000); // 0.01% tolerance
          expect(actualShortRepaid).to.be.closeTo(expectedShortToRepay, shortRepaidTolerance as any);

          // Verify ~50% of long was redeemed (total = longForRepay + longForProfit)
          const actualLongRedeemed = longBalanceAfterOpen.sub(longBalanceAfterClose);
          const totalLongRedeemed = longForRepay.add(longForProfit);
          const longRedeemTolerance = totalLongRedeemed.mul(1).div(10000); // 0.01% tolerance
          expect(actualLongRedeemed).to.be.closeTo(totalLongRedeemed, longRedeemTolerance as any);

          // Verify profit (DSA underlying) was added to position account in DSA market
          const dsaUnderlyingIncrease = dsaUnderlyingAfter.sub(dsaUnderlyingBefore);
          expect(dsaUnderlyingIncrease).to.be.gt(0, "DSA underlying balance should increase from profit");

          // Validate DSA underlying increase matches expected profit from swap
          const dsaTolerance = estimatedProfitInDsa.mul(1).div(100); // 1% tolerance
          expect(dsaUnderlyingIncrease).to.be.closeTo(estimatedProfitInDsa, dsaTolerance as any);

          // Position remains active after partial close
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true);
        });

        it("full close with profit from price movement", async () => {
          const INITIAL_PRINCIPAL = parseEther("11000");
          const SHORT_AMOUNT = parseEther("6");
          const leverage = parseEther("2.5");
          const closeFractionBps = 10000; // Full close

          // ========================================
          // SETUP: Fund Alice with DSA tokens
          // ========================================
          const whaleSigner = await initMainnetUser(DSA_WHALE, parseEther("1"));
          await dsa.connect(whaleSigner).transfer(alice.address, INITIAL_PRINCIPAL);
          await dsa.connect(alice).approve(rpm.address, INITIAL_PRINCIPAL);

          // ========================================
          // STEP 1: Activate + Open Position (Combined)
          // ========================================
          const { swapData: openSwapData, minAmountOut: minLong } = await getSwapData(
            SHORT_ADDRESS,
            LONG_ADDRESS,
            SHORT_AMOUNT.toString(),
            leverageManager.address,
            "0.01", // 1% slippage
          );

          await rpm
            .connect(alice)
            .activateAndOpenPosition(
              longVToken.address,
              shortVToken.address,
              0,
              INITIAL_PRINCIPAL,
              leverage,
              SHORT_AMOUNT,
              minLong,
              openSwapData,
            );

          const position = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          const positionAccount = position.positionAccount;

          // VALIDATION: Verify position is active after activation
          expect(position.isActive).to.eq(true, "Position should be active after activation");

          // Record state after opening position
          const shortDebtAfterOpen = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterOpen = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate position was opened successfully
          // VALIDATION 1: Verify short debt matches borrowed amount (within 0.01% tolerance for interest)
          const shortDebtTolerance = SHORT_AMOUNT.mul(1).div(10000); // 0.01% tolerance
          expect(shortDebtAfterOpen).to.be.closeTo(SHORT_AMOUNT, shortDebtTolerance as any);

          // VALIDATION 2: Verify long balance meets or exceeds the minimum amount out from swap
          expect(longBalanceAfterOpen).to.be.gte(minLong, "Long balance should be >= minimum amount out");

          // ========================================
          // STEP 3: Simulate Favorable Price Movement
          // ========================================

          const expectedLongToRedeem = longBalanceAfterOpen;
          const expectedShortToRepay = shortDebtAfterOpen;

          // Simulate 25% favorable price: we can use less LONG to get the needed SHORT
          // Split LONG: 75% for repay (due to favorable price), 25% for profit
          const longForRepay = expectedLongToRedeem.mul(75).div(100);
          const longForProfit = expectedLongToRedeem.sub(longForRepay);

          // Add buffer to swap output: contract adds 2% for full close, we add 0.2% for interest = 2.2% total
          const shortAmountFromRepaySwap = expectedShortToRepay.mul(1022).div(1000); // 2.2% buffer

          // Repay swap outputs SHORT with buffer for interest and full close tolerance
          const repaySwapData = await getManipulatedSwapData(
            LONG_ADDRESS,
            SHORT_ADDRESS,
            longForRepay,
            shortAmountFromRepaySwap, // With buffer
            leverageManager.address,
          );

          // Estimate how much DSA we'll get from profit LONG
          // LONG is WBNB (~$500), DSA is USDC (~$1), so 1 LONG ~= 500 DSA
          const estimatedProfitInDsa = longForProfit.mul(500); // Rough estimate: 1 LONG ~= 500 DSA

          // Get manipulated swap data for profit conversion (LONG → DSA)
          // Recipient is RPM contract, - profit gets converted to principal
          const profitSwapData = await getManipulatedSwapData(
            LONG_ADDRESS,
            DSA_ADDRESS,
            longForProfit,
            estimatedProfitInDsa,
            rpm.address, // Profit goes to RPM contract, then supplied as principal
          );

          // Record underlying DSA balance in position account (in DSA market) before close
          const dsaVToken = (await ethers.getContractAt("IVToken", vDSA_ADDRESS)) as IVToken;
          const dsaUnderlyingBefore = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);

          // Execute full close with profit
          // Use same buffer for minAmountOutRepay to pass validation
          const minAmountOutRepay = shortAmountFromRepaySwap; // Same as swap output

          await rpm.connect(alice).closeWithProfit(
            longVToken.address,
            shortVToken.address,
            closeFractionBps,
            longForRepay, // longAmountToRedeemForRepay
            minAmountOutRepay, // minAmountOutRepay (with 2.2% buffer)
            repaySwapData, // swapDataRepay
            longForProfit, // longAmountToRedeemForProfit
            estimatedProfitInDsa.mul(98).div(100), // minAmountOutProfit
            profitSwapData, // swapDataProfit
          );

          // ========================================
          // VALIDATION: Verify Final State
          // ========================================

          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longBalanceAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const dsaUnderlyingAfter = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);

          // Verify all debt was repaid
          expect(shortDebtAfterClose).to.eq(0, "Short debt should be 0 after full close");

          // Verify all long was redeemed (total = longForRepay + longForProfit)
          expect(longBalanceAfterClose).to.eq(0, "Long balance should be 0 after full close");

          // Verify profit (DSA underlying) was added to position account in DSA market
          const dsaUnderlyingIncrease = dsaUnderlyingAfter.sub(dsaUnderlyingBefore);
          expect(dsaUnderlyingIncrease).to.be.gt(0, "DSA underlying balance should increase from profit");

          // Validate DSA underlying increase matches expected profit from swap
          const dsaTolerance = estimatedProfitInDsa.mul(1).div(100); // 1% tolerance
          expect(dsaUnderlyingIncrease).to.be.closeTo(estimatedProfitInDsa, dsaTolerance as any);

          // Position remains active (requires explicit deactivation)
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true);
        });
      });

      describe("when LONG token is same as DSA token", () => {
        // Whales for funding SwapHelper in this block (vTokens hold the underlying; token contracts may not)
        const SHORT_WHALE = vSHORT_ADDRESS;
        const DSA_WHALE_FOR_SWAP = vDSA_ADDRESS;

        it("partial close with loss when LONG = DSA", async () => {
          const DSA_AMOUNT = parseEther("6000");
          const dsaAddress = DSA_ADDRESS;
          const longAddress = DSA_ADDRESS;
          const shortAddress = SHORT_ADDRESS;
          const shortToken = short;

          const {
            positionAccount,
            shortDebtAfterOpen,
            longBalanceAfterOpen: longCollateralAfterOpen,
            effectiveLongVToken: longVToken,
          } = await activateAndOpenPosition({
            initialPrincipal: parseEther("14000"),
            shortAmount: parseEther("1.25"),
            longAmount: parseEther("4500"),
            leverage: parseEther("2"),
            useLongVToken: dsaVToken,
            longAddress: DSA_ADDRESS,
            tokenOutWhaleOverride: DSA_WHALE_FOR_SWAP,
          });

          // ========================================
          // STEP 3: Partial Close with Loss (50%)
          // ========================================

          const closeFractionBps = 5000; // 50% partial close

          // Proportional amounts from contract's notion of long collateral (match _getProportionalCloseAmounts)
          const expectedLongToRedeem = longCollateralAfterOpen.mul(closeFractionBps).div(10000);
          const expectedShortToRepay = shortDebtAfterOpen.mul(closeFractionBps).div(10000);

          const longToRedeem = expectedLongToRedeem;
          const shortAmountAfterLongSwap = expectedShortToRepay.mul(85).div(100); // 15% loss
          const shortfall = expectedShortToRepay.sub(shortAmountAfterLongSwap);

          // First swap data: LONG → SHORT (simulated loss). LM executes swap and must receive tokenOut.
          const firstSwapData = await getManipulatedSwapData(
            longAddress,
            shortAddress,
            longToRedeem,
            shortAmountAfterLongSwap,
            leverageManager.address,
            SHORT_WHALE, // tokens to send
          );

          // Use 20% of initial DSA principal for the second swap input
          const dsaToSpend = DSA_AMOUNT.mul(20).div(100);

          // Add a small buffer on SHORT output to cover rounding/interest
          const shortAmountFromDsaSwap = shortfall.mul(1002).div(1000); // 0.2% buffer

          // Second swap data: DSA → SHORT (to cover shortfall). LM executes and must receive tokenOut.
          const secondSwapData = await getManipulatedSwapData(
            dsaAddress,
            shortAddress,
            dsaToSpend,
            shortAmountFromDsaSwap,
            leverageManager.address,
            SHORT_WHALE,
          );

          const aliceShortBalanceBefore = await shortToken.balanceOf(alice.address);
          const suppliedPrincipalUnderlyingBefore = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          await rpm
            .connect(alice)
            .closeWithLoss(
              longVToken.address,
              shortVToken.address,
              closeFractionBps,
              longToRedeem,
              shortAmountAfterLongSwap,
              shortAmountAfterLongSwap,
              firstSwapData,
              dsaToSpend,
              shortAmountFromDsaSwap,
              secondSwapData,
            );

          const aliceShortBalanceAfter = await shortToken.balanceOf(alice.address);
          const suppliedPrincipalUnderlyingAfter = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longCollateralAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Actual amounts changed by the partial close
          const actualShortRepaid = shortDebtAfterOpen.sub(shortDebtAfterClose);
          const actualLongRedeemed = longCollateralAfterOpen.sub(longCollateralAfterClose);

          // Validate partial close (50%): amounts redeemed/repaid close to expected (tight 0.01% tolerance)
          const longRedeemTolerance = expectedLongToRedeem.mul(1).div(10000); // 0.01% tolerance
          expect(actualLongRedeemed).to.be.closeTo(expectedLongToRedeem, longRedeemTolerance as any);
          const shortRepaidTolerance = expectedShortToRepay.mul(1).div(10000); // 0.01% tolerance
          expect(actualShortRepaid).to.be.closeTo(expectedShortToRepay, shortRepaidTolerance as any);

          // Remaining balances should be ~50% of initial (within 2% tolerance)
          const expectedRemainingShortDebt = shortDebtAfterOpen.sub(expectedShortToRepay);
          const expectedRemainingLongCollateral = longCollateralAfterOpen.sub(expectedLongToRedeem);
          const remainingShortTolerance = expectedRemainingShortDebt.mul(1).div(10000); // 0.01% tolerance
          const remainingLongTolerance = expectedRemainingLongCollateral.mul(1).div(10000); // 0.01% tolerance
          expect(shortDebtAfterClose).to.be.closeTo(expectedRemainingShortDebt, remainingShortTolerance as any);
          expect(longCollateralAfterClose).to.be.closeTo(
            expectedRemainingLongCollateral,
            remainingLongTolerance as any,
          );
          expect(shortDebtAfterClose).to.be.gt(0, "Short debt should be > 0 after partial close");
          expect(longCollateralAfterClose).to.be.gt(0, "Long collateral should be > 0 after partial close");

          // Validate dust transfer
          const dustReceived = aliceShortBalanceAfter.sub(aliceShortBalanceBefore);
          const expectedDust = shortAmountFromDsaSwap.sub(shortfall);
          expect(dustReceived).to.be.gte(0, "Alice should receive dust from excess swap output");
          expect(dustReceived).to.be.lte(expectedDust, "Dust should not exceed expected amount");

          // Position remains active
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true);

          // When LONG = DSA, second leg redeems dsaToSpend (underlying) from DSA; principal should decrease by that amount
          const expectedSuppliedPrincipalAfter = suppliedPrincipalUnderlyingBefore.sub(dsaToSpend);
          const principalTolerance = dsaToSpend.mul(1).div(10000); // 0.01% tolerance (exchange rate / rounding)
          expect(suppliedPrincipalUnderlyingAfter).to.be.closeTo(
            expectedSuppliedPrincipalAfter,
            principalTolerance as any,
            "Supplied principal (underlying) should decrease only by dsaToSpend redeemed in second leg",
          );
        });

        it("full close with loss when LONG = DSA", async () => {
          const DSA_AMOUNT = parseEther("7000");
          const dsaAddress = DSA_ADDRESS;
          const longAddress = DSA_ADDRESS;
          const shortAddress = SHORT_ADDRESS;
          const shortToken = short;

          const {
            positionAccount,
            shortDebtAfterOpen,
            longBalanceAfterOpen: longCollateralAfterOpen,
            effectiveLongVToken: longVToken,
          } = await activateAndOpenPosition({
            initialPrincipal: parseEther("16000"),
            shortAmount: parseEther("1.5"),
            longAmount: parseEther("5000"),
            leverage: parseEther("2"),
            useLongVToken: dsaVToken,
            longAddress: DSA_ADDRESS,
            tokenOutWhaleOverride: DSA_WHALE_FOR_SWAP,
            accrueAfterOpen: true,
          });

          // ========================================
          // STEP 3: Full Close with Loss (100%)
          // ========================================

          const closeFractionBps = 10000; // 100% full close

          // 100% full close: use contract's long collateral
          const expectedLongToRedeem = longCollateralAfterOpen;
          const expectedShortToRepay = shortDebtAfterOpen;

          const longToRedeem = expectedLongToRedeem;
          const shortAmountAfterLongSwap = expectedShortToRepay.mul(80).div(100); // 20% loss
          const shortfall = expectedShortToRepay.sub(shortAmountAfterLongSwap);

          // First swap data: LONG → SHORT (simulated loss). LM executes and must receive tokenOut.
          const firstSwapData = await getManipulatedSwapData(
            longAddress,
            shortAddress,
            longToRedeem,
            shortAmountAfterLongSwap,
            leverageManager.address,
            SHORT_WHALE,
          );

          // Use 25% of initial principal as arbitrary DSA input amount
          const dsaToSpend = DSA_AMOUNT.mul(25).div(100);

          // For full close, add 2.2% buffer (0.2% interest + 2% contract tolerance)
          const shortAmountFromDsaSwap = shortfall.mul(1022).div(1000);

          // Second swap data: DSA → SHORT (to cover shortfall). LM executes and must receive tokenOut.
          const secondSwapData = await getManipulatedSwapData(
            dsaAddress,
            shortAddress,
            dsaToSpend,
            shortAmountFromDsaSwap,
            leverageManager.address,
            SHORT_WHALE,
          );

          const aliceShortBalanceBefore = await shortToken.balanceOf(alice.address);
          const suppliedPrincipalUnderlyingBefore = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          await rpm
            .connect(alice)
            .closeWithLoss(
              longVToken.address,
              shortVToken.address,
              closeFractionBps,
              longToRedeem,
              shortAmountAfterLongSwap,
              shortAmountAfterLongSwap,
              firstSwapData,
              dsaToSpend,
              shortAmountFromDsaSwap,
              secondSwapData,
            );

          const aliceShortBalanceAfter = await shortToken.balanceOf(alice.address);
          const suppliedPrincipalUnderlyingAfterClose = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longCollateralAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate full close
          expect(shortDebtAfterClose).to.be.eq(0, "Short debt should be 0 after full close");
          expect(longCollateralAfterClose).to.be.eq(0, "Long collateral should be 0 after full close");

          // Supplied principal (underlying) should decrease only by dsaToSpend redeemed in second leg
          const expectedSuppliedPrincipalAfterClose = suppliedPrincipalUnderlyingBefore.sub(dsaToSpend);
          const principalTolerance = dsaToSpend.mul(1).div(10000); // 0.01% tolerance
          expect(suppliedPrincipalUnderlyingAfterClose).to.be.closeTo(
            expectedSuppliedPrincipalAfterClose,
            principalTolerance as any,
            "Supplied principal (underlying) should decrease only by dsaToSpend after full close with loss",
          );

          // Validate dust transfer
          const dustReceived = aliceShortBalanceAfter.sub(aliceShortBalanceBefore);
          const expectedDust = shortAmountFromDsaSwap.sub(shortfall);
          expect(dustReceived).to.be.gte(0, "Alice should receive dust from excess swap output");
          expect(dustReceived).to.be.lte(expectedDust, "Dust should not exceed expected amount");

          // closeWithLoss does not set isActive = false; user must call deactivatePosition to withdraw principal and deactivate
          await rpm.connect(alice).deactivatePosition(longVToken.address, shortVToken.address);
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(false);

          // After deactivatePosition, supplied principal should be 0 (withdrawn to user)
          const suppliedPrincipalAfterDeactivate = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          expect(suppliedPrincipalAfterDeactivate).to.eq(0, "Supplied principal should be 0 after deactivatePosition");
        });

        it("partial close with profit when LONG = DSA", async () => {
          const longAddress = DSA_ADDRESS;
          const shortAddress = SHORT_ADDRESS;

          const {
            positionAccount,
            shortDebtAfterOpen,
            longBalanceAfterOpen: longCollateralAfterOpen,
            effectiveLongVToken: longVToken,
          } = await activateAndOpenPosition({
            initialPrincipal: parseEther("10000"),
            shortAmount: parseEther("1"),
            longAmount: parseEther("4000"),
            leverage: parseEther("2"),
            useLongVToken: dsaVToken,
            longAddress: DSA_ADDRESS,
            tokenOutWhaleOverride: DSA_WHALE_FOR_SWAP,
            accrueAfterOpen: true,
          });

          // ========================================
          // STEP 3: Partial Close with Profit (50%)
          // ========================================

          const closeFractionBps = 5000; // 50% partial close

          // Proportional amounts from contract's long collateral (must match _getProportionalCloseAmounts)
          const expectedLongToRedeem = longCollateralAfterOpen.mul(closeFractionBps).div(10000);
          const expectedShortToRepay = shortDebtAfterOpen.mul(closeFractionBps).div(10000);

          // Redeem 80% of proportional long to repay debt, 20% as profit supplied to principal (total 100% within tolerance).
          const longAmountToRedeemForRepay = expectedLongToRedeem.mul(80).div(100);
          const longAmountToRedeemForProfit = expectedLongToRedeem.mul(20).div(100); // when LONG = DSA this is supplied to principal
          const minAmountOutRepay = expectedShortToRepay.mul(1002).div(1000); // 0.2% buffer

          // Repay swap: LM executes and must receive SHORT.
          const firstSwapData = await getManipulatedSwapData(
            longAddress,
            shortAddress,
            longAmountToRedeemForRepay,
            minAmountOutRepay,
            leverageManager.address,
            SHORT_WHALE,
          );

          // When LONG = DSA, profit is supplied to principal with no swap (long is already DSA).
          const estimatedProfitInDsa = longAmountToRedeemForProfit;
          const secondSwapData = "0x";
          const dsaUnderlyingBefore = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          const suppliedPrincipalBefore = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          await rpm
            .connect(alice)
            .closeWithProfit(
              longVToken.address,
              shortVToken.address,
              closeFractionBps,
              longAmountToRedeemForRepay,
              minAmountOutRepay,
              firstSwapData,
              longAmountToRedeemForProfit,
              estimatedProfitInDsa,
              secondSwapData,
            );

          const dsaUnderlyingAfter = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          const suppliedPrincipalAfter = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longCollateralAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate partial close
          expect(shortDebtAfterClose).to.be.lt(shortDebtAfterOpen, "Short debt should decrease");
          expect(longCollateralAfterClose).to.be.lt(longCollateralAfterOpen, "Long collateral should decrease");
          expect(shortDebtAfterClose).to.be.gt(0, "Short debt should be > 0 after partial close");
          expect(longCollateralAfterClose).to.be.gt(0, "Long collateral should be > 0 after partial close");

          // When LONG = DSA, we redeem long (DSA) for repay, so position account DSA underlying decreases; close succeeded
          expect(dsaUnderlyingAfter).to.be.lte(dsaUnderlyingBefore, "Partial close redeems long (DSA) for repay");

          // Redeemed long (profit leg) is added to supplied DSA: supplied principal should increase by that amount
          const expectedSuppliedPrincipalAfter = suppliedPrincipalBefore.add(longAmountToRedeemForProfit);
          const suppliedPrincipalTolerance = longAmountToRedeemForProfit.mul(1).div(10000); // 0.01%
          expect(suppliedPrincipalAfter).to.be.closeTo(
            expectedSuppliedPrincipalAfter,
            suppliedPrincipalTolerance as any,
            "Redeemed long for profit is added to supplied DSA; supplied principal increases by profit amount",
          );

          // Overall DSA balance in the market for the account: decrease = amount redeemed for repay only (profit stays in market as principal)
          const dsaRedeemedForRepay = dsaUnderlyingBefore.sub(dsaUnderlyingAfter);
          const redeemedTolerance = longAmountToRedeemForRepay.mul(1).div(10000); // 0.01%
          expect(dsaRedeemedForRepay).to.be.closeTo(
            longAmountToRedeemForRepay,
            redeemedTolerance as any,
            "Overall DSA balance decrease equals redeemed long for repay (profit added to principal)",
          );

          // Position remains active
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(true);
        });

        it("full close with profit when LONG = DSA", async () => {
          const longAddress = DSA_ADDRESS;
          const shortAddress = SHORT_ADDRESS;

          const {
            positionAccount,
            shortDebtAfterOpen,
            longBalanceAfterOpen: longCollateralAfterOpen,
            effectiveLongVToken: longVToken,
          } = await activateAndOpenPosition({
            initialPrincipal: parseEther("10000"),
            shortAmount: parseEther("1"),
            longAmount: parseEther("4000"),
            leverage: parseEther("2"),
            useLongVToken: dsaVToken,
            longAddress: DSA_ADDRESS,
            tokenOutWhaleOverride: DSA_WHALE_FOR_SWAP,
            accrueAfterOpen: true,
          });

          // ========================================
          // STEP 3: Full Close with Profit (100%)
          // ========================================

          const closeFractionBps = 10000; // 100% full close

          const expectedLongToRedeem = longCollateralAfterOpen;
          const expectedShortToRepay = shortDebtAfterOpen;

          // 80% of long to repay debt, 20% as profit supplied to principal (LONG = DSA).
          const longAmountToRedeemForRepay = expectedLongToRedeem.mul(80).div(100);
          const longAmountToRedeemForProfit = expectedLongToRedeem.mul(20).div(100);
          const minAmountOutRepay = expectedShortToRepay.mul(1022).div(1000); // 2.2% buffer for full close

          // Repay swap: LM executes and must receive SHORT.
          const firstSwapData = await getManipulatedSwapData(
            longAddress,
            shortAddress,
            longAmountToRedeemForRepay,
            minAmountOutRepay,
            leverageManager.address,
            SHORT_WHALE,
          );

          // When LONG = DSA, profit is supplied to principal with no swap.
          const estimatedProfitInDsa = longAmountToRedeemForProfit;
          const secondSwapData = "0x";
          const dsaUnderlyingBefore = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          const suppliedPrincipalBefore = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          await rpm
            .connect(alice)
            .closeWithProfit(
              longVToken.address,
              shortVToken.address,
              closeFractionBps,
              longAmountToRedeemForRepay,
              minAmountOutRepay,
              firstSwapData,
              longAmountToRedeemForProfit,
              estimatedProfitInDsa,
              secondSwapData,
            );

          const dsaUnderlyingAfter = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          const suppliedPrincipalAfter = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const shortDebtAfterClose = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const longCollateralAfterClose = await rpm.callStatic.getLongCollateralBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          // Validate full close
          expect(shortDebtAfterClose).to.be.eq(0, "Short debt should be 0 after full close");
          expect(longCollateralAfterClose).to.be.eq(0, "Long collateral should be 0 after full close");

          // When LONG = DSA, we redeem long (DSA) for repay, so position account DSA underlying decreases
          expect(dsaUnderlyingAfter).to.be.lte(dsaUnderlyingBefore, "Full close redeems long (DSA) for repay");

          // Redeemed long (profit leg) is added to supplied DSA: supplied principal should increase by profit amount
          const expectedSuppliedPrincipalAfter = suppliedPrincipalBefore.add(longAmountToRedeemForProfit);
          const suppliedPrincipalTolerance = longAmountToRedeemForProfit.mul(1).div(10000); // 0.01%
          expect(suppliedPrincipalAfter).to.be.closeTo(
            expectedSuppliedPrincipalAfter,
            suppliedPrincipalTolerance as any,
            "Redeemed long for profit is added to supplied DSA; supplied principal increases by profit amount",
          );

          // closeWithProfit does not set isActive = false; user must call deactivatePosition
          await rpm.connect(alice).deactivatePosition(longVToken.address, shortVToken.address);
          const positionAfterClose = await rpm.getPosition(alice.address, longVToken.address, shortVToken.address);
          expect(positionAfterClose.isActive).to.eq(false);
        });
      });

      describe("liquidation scenarios", () => {
        let liquidator: any;
        let shortToken: IERC20;
        let shortVTokenLiquidate: any;

        beforeEach(async () => {
          const [, , signer] = await ethers.getSigners();
          liquidator = signer;

          // Set liquidator contract so this signer is allowed to call liquidateBorrow
          const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseEther("1"));
          await comptroller.connect(timelock)._setLiquidatorContract(liquidator.address);

          // Fund liquidator with SHORT tokens upfront
          shortToken = IERC20__factory.connect(SHORT_ADDRESS, ethers.provider);
          const shortWhaleSigner = await initMainnetUser(SHORT_WHALE_LIQUIDATION, parseEther("1"));
          await shortToken.connect(shortWhaleSigner).transfer(liquidator.address, parseEther("10"));

          shortVTokenLiquidate = VBep20Interface__factory.connect(vSHORT_ADDRESS, liquidator);
        });

        it("liquidate position and seize DSA token", async () => {
          const { positionAccount, shortDebtAfterOpen } = await activateAndOpenPosition({
            initialPrincipal: parseEther("1500"),
            shortAmount: parseEther("1.5"),
            longAmount: parseEther("30"),
            leverage: parseEther("3"),
            tokenOutWhaleOverride: vLONG_ADDRESS,
          });

          const dsaBalanceAfterOpen = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          expect(shortDebtAfterOpen).to.be.gt(0, "Should have short debt");
          expect(dsaBalanceAfterOpen).to.be.gt(0, "Should have DSA principal");

          // ========================================
          // STEP 3: Drop LONG (WBNB) price to make position liquidatable
          // ========================================
          const oracleAddr = await comptroller.oracle();
          const oracle = ResilientOracleInterface__factory.connect(oracleAddr, ethers.provider);
          const wbnbPriceBefore = await oracle.getPrice(LONG_ADDRESS);
          const wbnbPriceDropped = wbnbPriceBefore.mul(10).div(100); // 90% drop
          await setOraclePrice(comptroller, LONG_ADDRESS, wbnbPriceDropped);

          // ========================================
          // STEP 4: Liquidate and seize DSA token
          // ========================================
          const repayAmount = shortDebtAfterOpen.div(4); // Liquidate 25% of debt
          await shortToken.connect(liquidator).approve(vSHORT_ADDRESS, repayAmount);

          const liquidatorVTokenBalanceBefore = await dsaVToken.balanceOf(liquidator.address);
          const dsaBalanceBeforeLiquidation = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          const suppliedPrincipalBeforeLiquidation = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          const positionBeforeLiquidation = await rpm.getPosition(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );

          await shortVTokenLiquidate.liquidateBorrow(
            positionAccount,
            repayAmount,
            dsaVToken.address, // Seize DSA collateral
          );

          const liquidatorVTokenBalanceAfter = await dsaVToken.balanceOf(liquidator.address);
          const dsaBalanceAfterLiquidation = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          const shortDebtAfterLiquidation = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);

          expect(shortDebtAfterLiquidation).to.be.lt(
            shortDebtAfterOpen,
            "Short debt should decrease after liquidation",
          );
          expect(dsaBalanceAfterLiquidation).to.be.lt(
            dsaBalanceBeforeLiquidation,
            "DSA balance should decrease (seized)",
          );
          expect(liquidatorVTokenBalanceAfter).to.be.gt(
            liquidatorVTokenBalanceBefore,
            "Liquidator should receive vDSA (collateral) tokens",
          );

          const seizedAmount = dsaBalanceBeforeLiquidation.sub(dsaBalanceAfterLiquidation);
          expect(seizedAmount).to.be.gt(0, "DSA tokens should be seized");

          // After seizure of vDSA, supplied principal (supplied DSA) for the position should be reduced
          const suppliedPrincipalAfterLiquidation = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          expect(suppliedPrincipalAfterLiquidation).to.be.lt(
            suppliedPrincipalBeforeLiquidation,
            "Supplied principal (supplied token) should be reduced after vToken seizure",
          );

          // Stored position.suppliedPrincipalVTokens (vToken amount) should be same after seizure
          const positionAfterLiquidation = await rpm.getPosition(
            alice.address,
            longVToken.address,
            shortVToken.address,
          );
          expect(positionAfterLiquidation.suppliedPrincipalVTokens).to.be.equal(
            positionBeforeLiquidation.suppliedPrincipalVTokens,
            "Stored position.suppliedPrincipalVTokens should be same vToken seizure",
          );
        });

        it("liquidate position and seize LONG token", async () => {
          const { positionAccount, shortDebtAfterOpen, longBalanceAfterOpen } = await activateAndOpenPosition({
            initialPrincipal: parseEther("2000"),
            shortAmount: parseEther("2"),
            longAmount: parseEther("40"),
            leverage: parseEther("3"),
            tokenOutWhaleOverride: vLONG_ADDRESS,
          });

          const dsaBalanceAfterOpen = await dsaVToken.callStatic.balanceOfUnderlying(positionAccount);
          expect(shortDebtAfterOpen).to.be.gt(0, "Should have short debt");
          expect(longBalanceAfterOpen).to.be.gt(0, "Should have long collateral");
          expect(dsaBalanceAfterOpen).to.be.gt(0, "Should have DSA principal");

          // ========================================
          // STEP 3: Drop LONG (WBNB) price to make position liquidatable
          // ========================================
          const oracleAddr = await comptroller.oracle();
          const oracle = ResilientOracleInterface__factory.connect(oracleAddr, ethers.provider);
          const wbnbPriceBefore = await oracle.getPrice(LONG_ADDRESS);
          const wbnbPriceDropped = wbnbPriceBefore.mul(10).div(100); // 90% drop
          await setOraclePrice(comptroller, LONG_ADDRESS, wbnbPriceDropped);

          // ========================================
          // STEP 4: Liquidate and seize LONG token
          // ========================================
          const shortDebtBeforeLiquidation = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const repayAmount = shortDebtBeforeLiquidation.div(3); // Liquidate 33% of debt
          await shortToken.connect(liquidator).approve(vSHORT_ADDRESS, repayAmount);

          const liquidatorVLongBalanceBefore = await longVToken.balanceOf(liquidator.address);
          const longBalanceBeforeLiquidation = await longVToken.callStatic.balanceOfUnderlying(positionAccount);

          // Verify position is liquidatable (shortfall > 0)
          const [, , shortfall] = await comptroller.getAccountLiquidity(positionAccount);
          expect(shortfall).to.be.gt(0, "Position should be liquidatable (shortfall > 0)");

          await shortVTokenLiquidate.liquidateBorrow(
            positionAccount,
            repayAmount,
            longVToken.address, // Seize LONG collateral
          );

          const liquidatorVLongBalanceAfter = await longVToken.balanceOf(liquidator.address);
          const longBalanceAfterLiquidation = await longVToken.callStatic.balanceOfUnderlying(positionAccount);
          const shortDebtAfterLiquidation = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);

          expect(shortDebtAfterLiquidation).to.be.lt(
            shortDebtBeforeLiquidation,
            "Short debt should decrease after liquidation",
          );
          expect(longBalanceAfterLiquidation).to.be.lt(
            longBalanceBeforeLiquidation,
            "LONG balance should decrease (seized)",
          );
          expect(liquidatorVLongBalanceAfter).to.be.gt(
            liquidatorVLongBalanceBefore,
            "Liquidator should receive vLONG (vToken) as seized collateral",
          );

          const seizedLongAmount = longBalanceBeforeLiquidation.sub(longBalanceAfterLiquidation);
          expect(seizedLongAmount).to.be.gt(0, "LONG tokens should be seized");

          // Position still has DSA and remaining debt; user could close with DSA later
          const remainingDebt = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          expect(remainingDebt).to.be.gt(0, "Remaining debt after partial liquidation");
          expect(dsaBalanceAfterOpen).to.be.gt(0, "Should still have DSA to repay with");
        });

        it("liquidate position and seize DSA token when LONG = DSA", async () => {
          const {
            positionAccount,
            shortDebtAfterOpen,
            longBalanceAfterOpen: longCollateralAfterOpen,
            effectiveLongVToken: longVTokenForTest,
          } = await activateAndOpenPosition({
            initialPrincipal: parseEther("8000"),
            shortAmount: parseEther("1"),
            longAmount: parseEther("3000"),
            leverage: parseEther("2"),
            useLongVToken: dsaVToken,
            longAddress: DSA_ADDRESS,
            tokenOutWhaleOverride: vDSA_ADDRESS,
          });

          // When LONG = DSA, use getSuppliedPrincipalBalance for just the DSA principal portion
          const dsaBalanceAfterOpen = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVTokenForTest.address,
            shortVToken.address,
          );

          expect(shortDebtAfterOpen).to.be.gt(0, "Should have short debt");
          expect(longCollateralAfterOpen).to.be.gt(0, "Should have long collateral");
          expect(dsaBalanceAfterOpen).to.be.gt(0, "Should have DSA principal");

          // ========================================
          // STEP 3: Drop LONG (DSA/USDC) price to make position liquidatable
          // ========================================
          const oracleAddr = await comptroller.oracle();
          const oracle = ResilientOracleInterface__factory.connect(oracleAddr, ethers.provider);
          const dsaPriceBefore = await oracle.getPrice(DSA_ADDRESS);
          const dsaPriceDropped = dsaPriceBefore.mul(10).div(100); // 90% drop
          await setOraclePrice(comptroller, DSA_ADDRESS, dsaPriceDropped);

          // ========================================
          // STEP 4: Liquidate and seize DSA (LONG) token
          // ========================================
          const shortDebtBeforeLiquidation = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const repayAmount = shortDebtBeforeLiquidation.div(5); // Liquidate 20% of debt
          await shortToken.connect(liquidator).approve(vSHORT_ADDRESS, repayAmount);

          const liquidatorVDSABalanceBefore = await dsaVToken.balanceOf(liquidator.address);
          const suppliedPrincipalBeforeLiquidation = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVTokenForTest.address,
            shortVToken.address,
          );

          // Verify position is liquidatable (shortfall > 0)
          const [, , shortfall] = await comptroller.getAccountLiquidity(positionAccount);
          expect(shortfall).to.be.gt(0, "Position should be liquidatable (shortfall > 0)");

          await shortVTokenLiquidate.liquidateBorrow(
            positionAccount,
            repayAmount,
            longVTokenForTest.address, // Seize DSA (which is LONG since LONG = DSA)
          );

          const liquidatorVDSABalanceAfter = await dsaVToken.balanceOf(liquidator.address);
          const shortDebtAfterLiquidation = await shortVToken.callStatic.borrowBalanceCurrent(positionAccount);
          const suppliedPrincipalAfterLiquidation = await rpm.callStatic.getSuppliedPrincipalBalance(
            alice.address,
            longVTokenForTest.address,
            shortVToken.address,
          );

          // Validate liquidation results
          expect(shortDebtAfterLiquidation).to.be.lt(
            shortDebtBeforeLiquidation,
            "Short debt should decrease after liquidation",
          );

          expect(suppliedPrincipalAfterLiquidation).to.be.lt(
            suppliedPrincipalBeforeLiquidation,
            "DSA principal balance should decrease (seized as LONG collateral)",
          );

          // Seized collateral is transferred as vToken (vDSA) to liquidator
          expect(liquidatorVDSABalanceAfter).to.be.gt(
            liquidatorVDSABalanceBefore,
            "Liquidator should receive vDSA (seized LONG collateral) tokens",
          );
        });
      });
    });
  });
}
