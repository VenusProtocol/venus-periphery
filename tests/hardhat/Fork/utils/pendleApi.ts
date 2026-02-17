import axios from "axios";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";

const PENDLE_API_BASE_URL = "https://api-v2.pendle.finance/core";

export interface ApproxParamsStruct {
  guessMin: BigNumber;
  guessMax: BigNumber;
  guessOffchain: BigNumber;
  maxIteration: number;
  eps: BigNumber;
}

export interface TokenInputStruct {
  tokenIn: string;
  netTokenIn: BigNumber;
  tokenMintSy: string;
  pendleSwap: string;
  swapData: {
    swapType: number;
    extRouter: string;
    extCalldata: string;
    needScale: boolean;
  };
}

export interface LimitOrderDataStruct {
  limitRouter: string;
  epsSkipMarket: number;
  normalFills: any[];
  flashFills: any[];
  optData: string;
}

export interface PendleSwapParams {
  minPtOut: BigNumber;
  approxParams: ApproxParamsStruct;
  tokenInput: TokenInputStruct;
  limitOrderData: LimitOrderDataStruct;
}

/**
 * Fetches swap parameters from Pendle v3 convert API
 * @param chainId Chain ID (56 for BSC)
 * @param tokenIn Input token address
 * @param ptToken PT token address (output)
 * @param amount Amount of tokenIn to swap (in wei)
 * @param receiver Receiver address for the transaction
 * @param slippage Slippage tolerance (e.g., 0.03 for 3%)
 * @param enableAggregator Whether to enable Pendle's aggregator routing (required for tokens
 *        not in tokensMintSy, e.g. WBNB). When true, Pendle uses external DEX aggregators
 *        (kyberswap, odos, etc.) to swap tokenIn → tokenMintSy before minting SY.
 * @returns Complete swap parameters from Pendle API
 */
export async function getPendleSwapParams(
  chainId: number,
  tokenIn: string,
  ptToken: string,
  amount: BigNumber,
  receiver: string,
  slippage: number = 0.03,
  enableAggregator: boolean = false,
): Promise<PendleSwapParams> {
  try {
    const response = await axios.post(`${PENDLE_API_BASE_URL}/v3/sdk/${chainId}/convert`, {
      receiver,
      slippage,
      enableAggregator,
      inputs: [
        {
          token: tokenIn,
          amount: amount.toString(),
        },
      ],
      outputs: [ptToken],
    });

    const data = response.data;

    // Extract contract call parameters from the first route
    const route = data.routes[0];
    const paramValues = route.contractParamInfo.contractCallParams;

    // Parse minPtOut (index 2)
    const minPtOut = BigNumber.from(paramValues[2]);

    // Parse approxParams from guessPtOut (index 3) - API returns structured object
    const approxParamsRaw = paramValues[3];
    const approxParams: ApproxParamsStruct = {
      guessMin: BigNumber.from(approxParamsRaw.guessMin),
      guessMax: BigNumber.from(approxParamsRaw.guessMax),
      guessOffchain: BigNumber.from(approxParamsRaw.guessOffchain),
      maxIteration: Number(approxParamsRaw.maxIteration),
      eps: BigNumber.from(approxParamsRaw.eps),
    };

    // Parse tokenInput from input (index 4) - API returns structured object
    const tokenInputRaw = paramValues[4];
    const tokenInput: TokenInputStruct = {
      tokenIn: tokenInputRaw.tokenIn,
      netTokenIn: BigNumber.from(tokenInputRaw.netTokenIn),
      tokenMintSy: tokenInputRaw.tokenMintSy,
      pendleSwap: tokenInputRaw.pendleSwap,
      swapData: {
        swapType: Number(tokenInputRaw.swapData.swapType),
        extRouter: tokenInputRaw.swapData.extRouter,
        // Ensure extCalldata is valid hex (convert empty string to "0x")
        extCalldata: tokenInputRaw.swapData.extCalldata || "0x",
        needScale: tokenInputRaw.swapData.needScale,
      },
    };

    // Parse limitOrderData from limit (index 5) - API returns structured object
    const limitOrderDataRaw = paramValues[5];
    const limitOrderData: LimitOrderDataStruct = {
      limitRouter: limitOrderDataRaw.limitRouter,
      epsSkipMarket: Number(limitOrderDataRaw.epsSkipMarket),
      normalFills: limitOrderDataRaw.normalFills || [],
      flashFills: limitOrderDataRaw.flashFills || [],
      // Ensure optData is valid hex (convert empty string to "0x")
      optData: limitOrderDataRaw.optData || "0x",
    };

    console.log("✓ Successfully fetched parameters from Pendle API");

    return {
      minPtOut,
      approxParams,
      tokenInput,
      limitOrderData,
    };
  } catch (error: any) {
    console.warn("⚠ Failed to fetch from Pendle API, falling back to estimated params");
    console.warn("  Error:", error.response?.data?.message || error.message);

    // Fallback to conservative estimates if API fails
    const estimatedPtOut = amount.mul(98).div(100); // Assume ~98% conversion rate
    return {
      minPtOut: estimatedPtOut.mul(97).div(100), // 97% of estimate with slippage
      approxParams: {
        guessMin: estimatedPtOut.mul(90).div(100),
        guessMax: estimatedPtOut.mul(105).div(100),
        guessOffchain: estimatedPtOut,
        maxIteration: 256,
        eps: parseUnits("0.00001", 18),
      },
      tokenInput: {
        tokenIn,
        netTokenIn: amount,
        tokenMintSy: tokenIn,
        pendleSwap: "0x0000000000000000000000000000000000000000",
        swapData: {
          swapType: 0,
          extRouter: "0x0000000000000000000000000000000000000000",
          extCalldata: "0x",
          needScale: false,
        },
      },
      limitOrderData: {
        limitRouter: "0x0000000000000000000000000000000000000000",
        epsSkipMarket: 0,
        normalFills: [],
        flashFills: [],
        optData: "0x",
      },
    };
  }
}

