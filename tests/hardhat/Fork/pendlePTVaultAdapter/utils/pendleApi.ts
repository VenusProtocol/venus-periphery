/**
 * Pendle v3 Convert API client for fork tests.
 *
 * Provides typed wrappers around the bidirectional `/core/v3/sdk/{chainId}/convert`
 * endpoint. The API auto-detects swap direction from the token types:
 *   - ERC-20/native as input + PT as output  -> swapExactTokenForPt params
 *   - PT as input + ERC-20/native as output  -> swapExactPtForToken params
 *
 * Includes rate-limit retry with exponential backoff and conservative fallback
 * params if the API is unreachable.
 */
import axios, { AxiosError } from "axios";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";

const PENDLE_API_BASE = "https://api-v2.pendle.finance/core/v3/sdk";
const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";

// ── Shared Types ────────────────────────────────────────────────────────

export interface SwapDataStruct {
  swapType: number;
  extRouter: string;
  extCalldata: string;
  needScale: boolean;
}

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
  swapData: SwapDataStruct;
}

export interface TokenOutputStruct {
  tokenOut: string;
  minTokenOut: BigNumber;
  tokenRedeemSy: string;
  pendleSwap: string;
  swapData: SwapDataStruct;
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

export interface PendlePtToTokenParams {
  tokenOutput: TokenOutputStruct;
  limitOrderData: LimitOrderDataStruct;
}

// ── HTTP Retry Helper ───────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * POST with exponential backoff on 429 (rate limit).
 * Retries up to `maxRetries` times with delays of 1s, 2s, 4s, 8s, 16s.
 */
async function postWithRetry(url: string, body: Record<string, unknown>, maxRetries = 5): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(url, body);
      return response;
    } catch (err: unknown) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;
      const isRateLimited = status === 429 || axiosErr.message?.includes("too many requests");

      if (isRateLimited && attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`  Pendle API rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  // Unreachable -- the loop always returns or throws -- but satisfies TypeScript.
  throw new Error("postWithRetry: exhausted retries without result");
}

// ── Shared Parsers ──────────────────────────────────────────────────────

function parseSwapData(raw: any): SwapDataStruct {
  return {
    swapType: Number(raw.swapType),
    extRouter: raw.extRouter,
    extCalldata: raw.extCalldata || "0x",
    needScale: raw.needScale,
  };
}

function parseLimitOrderData(raw: any): LimitOrderDataStruct {
  return {
    limitRouter: raw.limitRouter,
    epsSkipMarket: Number(raw.epsSkipMarket),
    normalFills: raw.normalFills || [],
    flashFills: raw.flashFills || [],
    optData: raw.optData || "0x",
  };
}

// ── Fallback Factories ──────────────────────────────────────────────────
// Used when the API is unreachable (network error, non-429 failure).
// These produce conservative estimates that may not work on-chain.

function fallbackSwapData(): SwapDataStruct {
  return { swapType: 0, extRouter: ADDRESS_ZERO, extCalldata: "0x", needScale: false };
}

function fallbackLimitOrderData(): LimitOrderDataStruct {
  return { limitRouter: ADDRESS_ZERO, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" };
}

// ── Public API Functions ────────────────────────────────────────────────

/**
 * Fetch token -> PT swap parameters from Pendle's convert endpoint.
 *
 * @param chainId       Chain ID (56 for BSC)
 * @param tokenIn       Input token address (or address(0) for native)
 * @param ptToken       PT token address (output)
 * @param amount        Amount of tokenIn in wei
 * @param receiver      Receiver address
 * @param slippage      Slippage tolerance (0.03 = 3%)
 * @param enableAggregator  Enable DEX aggregator routing for tokens not in tokensMintSy
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
    const response = await postWithRetry(`${PENDLE_API_BASE}/${chainId}/convert`, {
      receiver,
      slippage,
      enableAggregator,
      inputs: [{ token: tokenIn, amount: amount.toString() }],
      outputs: [ptToken],
    });

    // API response: routes[0].contractParamInfo.contractCallParams
    // For swapExactTokenForPt(receiver, market, minPtOut, guessPtOut, input, limit):
    //   [0]=receiver  [1]=market  [2]=minPtOut  [3]=guessPtOut  [4]=input  [5]=limit
    const params = response.data.routes[0].contractParamInfo.contractCallParams;

    const minPtOut = BigNumber.from(params[2]);

    const approxRaw = params[3];
    const approxParams: ApproxParamsStruct = {
      guessMin: BigNumber.from(approxRaw.guessMin),
      guessMax: BigNumber.from(approxRaw.guessMax),
      guessOffchain: BigNumber.from(approxRaw.guessOffchain),
      maxIteration: Number(approxRaw.maxIteration),
      eps: BigNumber.from(approxRaw.eps),
    };

    const inputRaw = params[4];
    const tokenInput: TokenInputStruct = {
      tokenIn: inputRaw.tokenIn,
      netTokenIn: BigNumber.from(inputRaw.netTokenIn),
      tokenMintSy: inputRaw.tokenMintSy,
      pendleSwap: inputRaw.pendleSwap,
      swapData: parseSwapData(inputRaw.swapData),
    };

    const limitOrderData = parseLimitOrderData(params[5]);

    console.log("  Pendle API: fetched token->PT swap params");
    return { minPtOut, approxParams, tokenInput, limitOrderData };
  } catch (err: unknown) {
    const axiosErr = err as AxiosError<{ message?: string }>;
    console.warn("  Pendle API: token->PT fetch failed, using fallback estimates");
    console.warn("  Error:", axiosErr.response?.data?.message || axiosErr.message);

    const estimatedPtOut = amount.mul(98).div(100);
    return {
      minPtOut: estimatedPtOut.mul(97).div(100),
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
        pendleSwap: ADDRESS_ZERO,
        swapData: fallbackSwapData(),
      },
      limitOrderData: fallbackLimitOrderData(),
    };
  }
}

/**
 * Fetch PT -> token swap parameters from Pendle's convert endpoint.
 *
 * @param chainId       Chain ID (56 for BSC)
 * @param ptToken       PT token address (input -- being sold)
 * @param tokenOut      Desired output token (or address(0) for native)
 * @param amount        Amount of PT tokens in wei
 * @param receiver      Receiver address
 * @param slippage      Slippage tolerance (0.03 = 3%)
 * @param enableAggregator  Required when tokenOut is NOT in tokensRedeemSy
 */
export async function getPendlePtToTokenParams(
  chainId: number,
  ptToken: string,
  tokenOut: string,
  amount: BigNumber,
  receiver: string,
  slippage: number = 0.03,
  enableAggregator: boolean = false,
): Promise<PendlePtToTokenParams> {
  try {
    const response = await postWithRetry(`${PENDLE_API_BASE}/${chainId}/convert`, {
      receiver,
      slippage,
      enableAggregator,
      inputs: [{ token: ptToken, amount: amount.toString() }],
      outputs: [tokenOut],
    });

    // For swapExactPtForToken(receiver, market, exactPtIn, output, limit):
    //   [0]=receiver  [1]=market  [2]=exactPtIn  [3]=TokenOutput  [4]=LimitOrderData
    const params = response.data.routes[0].contractParamInfo.contractCallParams;

    const outputRaw = params[3];
    const tokenOutput: TokenOutputStruct = {
      tokenOut: outputRaw.tokenOut,
      minTokenOut: BigNumber.from(outputRaw.minTokenOut),
      tokenRedeemSy: outputRaw.tokenRedeemSy,
      pendleSwap: outputRaw.pendleSwap,
      swapData: parseSwapData(outputRaw.swapData),
    };

    const limitOrderData = parseLimitOrderData(params[4]);

    console.log("  Pendle API: fetched PT->token swap params");
    return { tokenOutput, limitOrderData };
  } catch (err: unknown) {
    const axiosErr = err as AxiosError<{ message?: string }>;
    console.warn("  Pendle API: PT->token fetch failed, using fallback estimates");
    console.warn("  Error:", axiosErr.response?.data?.message || axiosErr.message);

    return {
      tokenOutput: {
        tokenOut,
        minTokenOut: amount.mul(95).div(100),
        tokenRedeemSy: tokenOut,
        pendleSwap: ADDRESS_ZERO,
        swapData: fallbackSwapData(),
      },
      limitOrderData: fallbackLimitOrderData(),
    };
  }
}
