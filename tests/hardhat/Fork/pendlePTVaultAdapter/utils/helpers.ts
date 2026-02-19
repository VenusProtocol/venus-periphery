import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  BNB_NATIVE,
  COMPTROLLER,
  LISTA_LISUSD,
  LISTA_RESILIENT_ORACLE,
  LISTA_STAKE_MANAGER,
  PANCAKE_ROUTER,
  SLISBNB,
  WBNB,
} from "./constants";

// ── Token Acquisition Helpers ───────────────────────────────────────────

/** Swap WBNB -> slisBNB via PancakeSwap V2 router. */
export async function getSlisbnbViaSwap(
  signer: SignerWithAddress,
  wbnbToken: Contract,
  slisbnbToken: Contract,
  amount: BigNumber,
): Promise<BigNumber> {
  const balanceBefore = await slisbnbToken.balanceOf(signer.address);

  const pancakeRouter = await ethers.getContractAt(
    [
      "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    ],
    PANCAKE_ROUTER,
  );

  await wbnbToken.connect(signer).approve(PANCAKE_ROUTER, amount);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  await pancakeRouter.connect(signer).swapExactTokensForTokens(amount, 0, [WBNB, SLISBNB], signer.address, deadline);

  const balanceAfter = await slisbnbToken.balanceOf(signer.address);
  return balanceAfter.sub(balanceBefore);
}

/** Deposit native BNB to ListaDAO StakeManager to receive slisBNB. */
export async function getSlisbnbViaListaDeposit(
  signer: SignerWithAddress,
  slisbnbToken: Contract,
  amount: BigNumber,
): Promise<BigNumber> {
  const balanceBefore = await slisbnbToken.balanceOf(signer.address);

  const stakeManager = await ethers.getContractAt(["function deposit() external payable"], LISTA_STAKE_MANAGER);
  await stakeManager.connect(signer).deposit({ value: amount });

  const balanceAfter = await slisbnbToken.balanceOf(signer.address);
  return balanceAfter.sub(balanceBefore);
}

/**
/**
 * KyberSwap's executor verifies a cryptographic signature over its swap
 * data (targetData). After time travel to PT maturity (~1.5yr), embedded
 * deadlines expire and any calldata patching invalidates the signature
 * (→ InvalidSignature() revert).
 *
 * Solution: replace the KyberSwap router at its on-chain address with
 * AggregatorMock (compiled Solidity contract) that performs a direct
 * PancakeSwap V2 swap, bypassing the executor entirely.
 *
 * Replace the aggregator router (e.g. KyberSwap) with AggregatorMock via
 * hardhat_setCode. The mock performs a direct PancakeSwap V2 swap instead
 * of calling the original executor. Storage at the address is preserved.
 *
 * @param routerAddress The aggregator router address to replace.
 * @param routerAddress  The aggregator router address to replace
 */
export async function replaceAggregatorWithMock(routerAddress: string): Promise<void> {
  const factory = await ethers.getContractFactory("AggregatorMock");
  const temp = await factory.deploy();
  await temp.deployed();
  const runtimeBytecode = await ethers.provider.getCode(temp.address);
  await ethers.provider.send("hardhat_setCode", [routerAddress, runtimeBytecode]);
}

// ── Dummy Struct Factories ──────────────────────────────────────────────
// Used by error-case tests where the contract reverts before consuming the struct.

export function getDummyApproxParams() {
  return {
    guessMin: 0,
    guessMax: 0,
    guessOffchain: 0,
    maxIteration: 0,
    eps: 0,
  };
}

export function getDummyTokenInput(tokenIn: string, netTokenIn: BigNumber | number) {
  return {
    tokenIn,
    netTokenIn,
    tokenMintSy: tokenIn,
    pendleSwap: ethers.constants.AddressZero,
    swapData: {
      swapType: 0,
      extRouter: ethers.constants.AddressZero,
      extCalldata: "0x",
      needScale: false,
    },
  };
}

export function getDummyLimitOrderData() {
  return {
    limitRouter: ethers.constants.AddressZero,
    epsSkipMarket: 0,
    normalFills: [],
    flashFills: [],
    optData: "0x",
  };
}

export function getDummyTokenOutput(tokenOut: string) {
  return {
    tokenOut,
    minTokenOut: 0,
    tokenRedeemSy: tokenOut,
    pendleSwap: ethers.constants.AddressZero,
    swapData: {
      swapType: 0,
      extRouter: ethers.constants.AddressZero,
      extCalldata: "0x",
      needScale: false,
    },
  };
}

// ── Oracle Staleness Fixups ─────────────────────────────────────────────
//
// Time-traveling ~1.5 years to reach PT maturity makes Chainlink price feeds
// stale. Both Lista DAO and Venus oracles enforce staleness checks that must
// be relaxed BEFORE time travel.

/**
 * Increase Lista DAO ResilientOracle timeDeltaTolerance for tokens queried
 * during SY deposit/redeem (lisUSD, slisBNB, WBNB).
 */
export async function increaseListaOracleTimeDeltaTolerance(): Promise<void> {
  const listaOracle = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function getTokenConfig(address) view returns (tuple(address asset, address[3] oracles, bool[3] enableFlagsForOracles, uint256 timeDeltaTolerance))",
      "function setTokenConfig(tuple(address asset, address[3] oracles, bool[3] enableFlagsForOracles, uint256 timeDeltaTolerance)) external",
    ],
    LISTA_RESILIENT_ORACLE,
  );

  const oracleOwner = await listaOracle.owner();
  await impersonateAccount(oracleOwner);
  await setBalance(oracleOwner, parseUnits("1", 18));
  const oracleOwnerSigner = await ethers.getSigner(oracleOwner);

  const TWO_YEARS = 2 * 365 * 24 * 3600;

  // lisUSD: queried by DynamicDutyCalculator.calculateDuty() via drip()
  // slisBNB (SLISBNB): queried during collateral price checks on withdraw
  // WBNB: queried by SlisBnbOracle to compute slisBNB/USD
  const tokensToFix = [LISTA_LISUSD, SLISBNB, WBNB];

  for (const token of tokensToFix) {
    try {
      const currentConfig = await listaOracle.getTokenConfig(token);
      await listaOracle.connect(oracleOwnerSigner).setTokenConfig({
        asset: token,
        oracles: currentConfig.oracles,
        enableFlagsForOracles: currentConfig.enableFlagsForOracles,
        timeDeltaTolerance: TWO_YEARS,
      });
    } catch {
      // Token not configured in Lista's oracle -- skip
    }
  }
}

/**
 * Increase Venus oracle maxStalePeriod on ChainlinkOracle/BinanceOracle
 * for BNB and slisBNB so stale feeds are accepted after time travel.
 */
export async function increaseVenusOracleMaxStalePeriod(): Promise<void> {
  const comptrollerContract = await ethers.getContractAt(["function oracle() view returns (address)"], COMPTROLLER);
  const venusOracleAddr = await comptrollerContract.oracle();
  const venusOracle = await ethers.getContractAt(
    [
      "function getTokenConfig(address) view returns (tuple(address asset, address[3] oracles, bool[3] enableFlagsForOracles, bool cachingEnabled))",
    ],
    venusOracleAddr,
  );

  const TWO_YEARS = 2 * 365 * 24 * 3600;

  const tokensToFix = [
    { address: BNB_NATIVE, symbol: "BNB" },
    { address: SLISBNB, symbol: "slisBNB" },
  ];

  for (const token of tokensToFix) {
    try {
      const config = await venusOracle.getTokenConfig(token.address);

      for (let i = 0; i < 3; i++) {
        const oracleAddr = config.oracles[i];
        if (oracleAddr === ethers.constants.AddressZero || !config.enableFlagsForOracles[i]) continue;

        try {
          const oracle = await ethers.getContractAt(
            ["function accessControlManager() view returns (address)"],
            oracleAddr,
          );
          const acmAddr = await oracle.accessControlManager();
          const acm = await ethers.getContractAt(
            [
              "function owner() view returns (address)",
              "function giveCallPermission(address, string, address) external",
            ],
            acmAddr,
          );
          const acmOwner = await acm.owner();
          await impersonateAccount(acmOwner);
          await setBalance(acmOwner, parseUnits("1", 18));
          const acmOwnerSigner = await ethers.getSigner(acmOwner);

          // Try ChainlinkOracle interface: setTokenConfig({asset, feed, maxStalePeriod})
          try {
            const chainlink = await ethers.getContractAt(
              [
                "function tokenConfigs(address) view returns (address asset, address feed, uint256 maxStalePeriod)",
                "function setTokenConfig(tuple(address asset, address feed, uint256 maxStalePeriod)) external",
              ],
              oracleAddr,
            );
            const tokenConfig = await chainlink.tokenConfigs(token.address);
            if (tokenConfig.asset !== ethers.constants.AddressZero) {
              await acm.connect(acmOwnerSigner).giveCallPermission(oracleAddr, "setTokenConfig(TokenConfig)", acmOwner);
              await chainlink.connect(acmOwnerSigner).setTokenConfig({
                asset: token.address,
                feed: tokenConfig.feed,
                maxStalePeriod: TWO_YEARS,
              });
              continue;
            }
          } catch {
            // Not a ChainlinkOracle -- fall through to BinanceOracle
          }

          // Try BinanceOracle interface: setMaxStalePeriod(symbol, stalePeriod)
          try {
            await acm
              .connect(acmOwnerSigner)
              .giveCallPermission(oracleAddr, "setMaxStalePeriod(string,uint256)", acmOwner);
            const binance = await ethers.getContractAt(
              ["function setMaxStalePeriod(string, uint256) external"],
              oracleAddr,
            );
            await binance.connect(acmOwnerSigner).setMaxStalePeriod(token.symbol, TWO_YEARS);
          } catch {
            // Neither ChainlinkOracle nor BinanceOracle -- skip
          }
        } catch {
          // Oracle doesn't have accessControlManager -- skip
        }
      }
    } catch {
      // Token not configured in Venus ResilientOracle -- skip
    }
  }
}
