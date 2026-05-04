// ═══════════════════════════════════════════════════════════════════════════
// DeviationSentinelConfigurator Fork Test — Network Configurations
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the address/market state hard-coded in the per-chain configurator
// contracts under contracts/helpers/. Any drift between these tables and the
// helper's `address constant` blocks will surface as a failed assertion.

export type OracleType = "uniswap" | "curve" | "aerodrome";

export interface MarketConfig {
  symbol: string;
  token: string;
  pool: string;
  oracleType: OracleType;
  // Curve-only StableSwap-NG fields
  coinIndex?: number;
  refCoinIndex?: number;
  referenceToken?: string;
  assetDecimals?: number;
}

export interface ConfiguratorNetworkConfig {
  networkName: string;
  label: string;
  // Block at which all 4–5 periphery contracts (DeviationSentinel, EBrake,
  // SentinelOracle, UniswapOracle, [+CurveOracle | +AerodromeOracle]) are
  // already deployed but not yet wired. Update if these change.
  forkBlock: number;
  // Solidity contract name resolved by `ethers.getContractFactory(...)`.
  factoryName: string;

  // ── Governance ──────────────────────────────────────────────────────────
  acm: string;
  guardian: string;
  normalTimelock: string;
  fastTrackTimelock: string;
  criticalTimelock: string;
  comptroller: string;

  // ── Periphery ───────────────────────────────────────────────────────────
  deviationSentinel: string;
  eBrake: string;
  sentinelOracle: string;
  uniswapOracle: string;
  curveOracle?: string;
  aerodromeOracle?: string;

  // ── Misc accounts ───────────────────────────────────────────────────────
  multisigPauser: string;
  keeper: string;

  // ── Markets ─────────────────────────────────────────────────────────────
  markets: MarketConfig[];
}

// ── Sigs (must mirror DeviationSentinelConfigurator.sol constants exactly) ──

export const SENTINEL_ADMIN_PERMS = [
  "setTrustedKeeper(address,bool)",
  "setTokenConfig(address,(uint8,bool))",
  "setTokenMonitoringEnabled(address,bool)",
];

export const SENTINEL_ORACLE_ADMIN_PERMS = ["setTokenOracleConfig(address,address)", "setDirectPrice(address,uint256)"];

export const UNISWAP_ORACLE_ADMIN_PERMS = ["setPoolConfig(address,address)"];

export const CURVE_ORACLE_ADMIN_PERMS = ["setPoolConfig(address,address,uint8,uint8,address,uint8)"];

export const AERODROME_ORACLE_ADMIN_PERMS = ["setPoolConfig(address,address)"];

export const EBRAKE_COMPTROLLER_PERMS_IL = [
  "setActionsPaused(address[],uint256[],bool)",
  "setCollateralFactor(address,uint256,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
];

export const RESET_PERMS = [
  "resetCFSnapshot(address)",
  "resetBorrowCapSnapshot(address)",
  "resetSupplyCapSnapshot(address)",
];

export const SENTINEL_EBRAKE_PERMS = ["pauseBorrow(address)", "pauseSupply(address)", "decreaseCF(address,uint256)"];

export const GOVERNANCE_EBRAKE_PERMS_IL = [
  "pauseSupply(address)",
  "pauseRedeem(address)",
  "pauseBorrow(address)",
  "pauseTransfer(address)",
  "pauseActions(address[],uint8[])",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
  "decreaseCF(address,uint256)",
];

// OZ AccessControl DEFAULT_ADMIN_ROLE — bytes32(0). The setup VIP grants this to the
// helper so it can call giveCallPermission / revokeCallPermission on the ACM (both
// wrap grantRole/revokeRole, which require the role admin = DEFAULT_ADMIN_ROLE).
export const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const TRANSIENT_BASE_PERMS_BY_HOST = (cfg: ConfiguratorNetworkConfig): Array<[string, string]> => [
  [cfg.deviationSentinel, "setTrustedKeeper(address,bool)"],
  [cfg.deviationSentinel, "setTokenConfig(address,(uint8,bool))"],
  [cfg.sentinelOracle, "setTokenOracleConfig(address,address)"],
  [cfg.uniswapOracle, "setPoolConfig(address,address)"],
];

export const TRANSIENT_CHAIN_SPECIFIC_PERMS_BY_HOST = (cfg: ConfiguratorNetworkConfig): Array<[string, string]> => {
  if (cfg.curveOracle) return [[cfg.curveOracle, "setPoolConfig(address,address,uint8,uint8,address,uint8)"]];
  if (cfg.aerodromeOracle) return [[cfg.aerodromeOracle, "setPoolConfig(address,address)"]];
  return [];
};

// ═══════════════════════════════════════════════════════════════════════════
// PER-CHAIN CONFIGS
// ═══════════════════════════════════════════════════════════════════════════

// NOTE on forkBlock: must be ≥ deployment block of all periphery contracts
// listed below. If the test reverts at fixture setup with a "no contract code
// at" error, bump this past the latest of the 4–5 deployment txs.

export const ETHEREUM_CONFIG: ConfiguratorNetworkConfig = {
  networkName: "ethereum",
  label: "Ethereum Mainnet",
  forkBlock: 25020867,
  factoryName: "DeviationSentinelConfiguratorEthereum",

  acm: "0x230058da2D23eb8836EC5DB7037ef7250c56E25E",
  guardian: "0x285960C5B22fD66A736C7136967A3eB15e93CC67",
  normalTimelock: "0xd969E79406c35E80750aAae061D402Aab9325714",
  fastTrackTimelock: "0x8764F50616B62a99A997876C2DEAaa04554C5B2E",
  criticalTimelock: "0xeB9b85342c34F65af734C7bd4a149c86c472bC00",
  comptroller: "0x687a01ecF6d3907658f7A7c714749fAC32336D1B",

  deviationSentinel: "0x7D0EFA41eBF1aF242A37174E1E047bD6ea1b1B9c",
  eBrake: "0xCD09042c5DFFed762998Df9a058ec5944e39949B",
  sentinelOracle: "0x444C53E194B40c272fAd683210e2cB1c16Ab132e",
  uniswapOracle: "0x873993F8f5f5Ddbae0952e939ab3005Af363Af00",
  curveOracle: "0x9F508F3146cb03276282f9237c6eE64f76E3261D",

  multisigPauser: "0xCCa5a587eBDBe80f23c8610F2e53B03158e62948",
  keeper: "0x57FA23F591203F61cef84A7BC892Df69Ca95C86e",

  markets: [
    {
      symbol: "WETH",
      token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
      oracleType: "uniswap",
    },
    {
      symbol: "WBTC",
      token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      pool: "0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35",
      oracleType: "uniswap",
    },
    {
      symbol: "USDC",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      pool: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",
      oracleType: "uniswap",
    },
    {
      symbol: "USDT",
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      pool: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",
      oracleType: "uniswap",
    },
    {
      symbol: "LBTC",
      token: "0x8236a87084f8B84306f72007F36F2618A5634494",
      pool: "0x87428a53e14d24Ab19c6Ca4939B4df93B8996cA9",
      oracleType: "uniswap",
    },
    {
      symbol: "USDe",
      token: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      pool: "0xE6D7EbB9f1a9519dc06D557e03C522d53520e76A",
      oracleType: "uniswap",
    },
    {
      symbol: "DAI",
      token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      pool: "0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168",
      oracleType: "uniswap",
    },
    {
      symbol: "tBTC",
      token: "0x18084fbA666a33d37592fA2633fD49a74DD93a88",
      pool: "0x97944213D2caeeA773DA1c9B11B0525F25b749CC",
      oracleType: "uniswap",
    },
    {
      symbol: "USDS",
      token: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
      pool: "0xe9F1E2EF814f5686C30ce6fb7103d0F780836C67",
      oracleType: "uniswap",
    },
    {
      symbol: "eBTC",
      token: "0x657e8C867D8B37dCC18fA4Caead9C45EB088C642",
      pool: "0x7704D01908afD31bf647d969c295BB45230cD2d6",
      oracleType: "curve",
      coinIndex: 0,
      refCoinIndex: 1,
      referenceToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      assetDecimals: 8,
    },
  ],
};

export const ARBITRUMONE_CONFIG: ConfiguratorNetworkConfig = {
  networkName: "arbitrumone",
  label: "Arbitrum One",
  forkBlock: 459255700,
  factoryName: "DeviationSentinelConfiguratorArbitrumOne",

  acm: "0xD9dD18EB0cf10CbA837677f28A8F9Bda4bc2b157",
  guardian: "0x14e0E151b33f9802b3e75b621c1457afc44DcAA0",
  normalTimelock: "0x4b94589Cc23F618687790036726f744D602c4017",
  fastTrackTimelock: "0x2286a9B2a5246218f2fC1F380383f45BDfCE3E04",
  criticalTimelock: "0x181E4f8F21D087bF02Ea2F64D5e550849FBca674",
  comptroller: "0x317c1A5739F39046E20b08ac9BeEa3f10fD43326",

  deviationSentinel: "0xb4CC54B33d34fD809E8fBD83A066158591ED7Fba",
  eBrake: "0xFc4CE7Ca9BB5119705Cfb84d6e4476e8a4032b26",
  sentinelOracle: "0x3563CAbc541a0432C66A64942ffB4070a9726226",
  uniswapOracle: "0xB6CFbfe6834EF519f002DBc1a8B81Ea437Ca647D",

  multisigPauser: "0xCCa5a587eBDBe80f23c8610F2e53B03158e62948",
  keeper: "0x57FA23F591203F61cef84A7BC892Df69Ca95C86e",

  markets: [
    {
      symbol: "WETH",
      token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      pool: "0xC6962004f452bE9203591991D15f6b388e09E8D0",
      oracleType: "uniswap",
    },
    {
      symbol: "WBTC",
      token: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      pool: "0x0E4831319A50228B9e450861297aB92dee15B44F",
      oracleType: "uniswap",
    },
    {
      symbol: "USDC",
      token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      pool: "0xbE3aD6a5669Dc0B8b12FeBC03608860C31E2eef6",
      oracleType: "uniswap",
    },
    {
      symbol: "USDT0",
      token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      pool: "0xbE3aD6a5669Dc0B8b12FeBC03608860C31E2eef6",
      oracleType: "uniswap",
    },
    {
      symbol: "ARB",
      token: "0x912CE59144191C1204E64559FE8253a0e49E6548",
      pool: "0xaEBDcA1Bc8d89177EbE2308d62af5e74885DcCc3",
      oracleType: "uniswap",
    },
  ],
};

export const BASEMAINNET_CONFIG: ConfiguratorNetworkConfig = {
  networkName: "basemainnet",
  label: "Base Mainnet",
  forkBlock: 45549641,
  factoryName: "DeviationSentinelConfiguratorBaseMainnet",

  acm: "0x9E6CeEfDC6183e4D0DF8092A9B90cDF659687daB",
  guardian: "0x1803Cf1D3495b43cC628aa1d8638A981F8CD341C",
  normalTimelock: "0x21c12f2946a1a66cBFf7eb997022a37167eCf517",
  fastTrackTimelock: "0x209F73Ee2Fa9A72aF3Fa6aF1933A3B58ed3De5D7",
  criticalTimelock: "0x47F65466392ff2aE825d7a170889F7b5b9D8e60D",
  comptroller: "0x0C7973F9598AA62f9e03B94E92C967fD5437426C",

  deviationSentinel: "0x12D09d5b13A673269cdB624D17A42f45a5233076",
  eBrake: "0x062C68Af7B9Fb059DCB7FA4B6b92E633350fb7c2",
  sentinelOracle: "0xCdD6D79Fd313C21967CED04C1b8bE70BDc27574D",
  uniswapOracle: "0xc3b5169a7d5f6341403c74187Db3C4Fe6d447762",
  aerodromeOracle: "0x5DE0B322A74088fD64CDD01042BE2fBc47FE82EC",

  multisigPauser: "0xCCa5a587eBDBe80f23c8610F2e53B03158e62948",
  keeper: "0x57FA23F591203F61cef84A7BC892Df69Ca95C86e",

  markets: [
    {
      symbol: "WETH",
      token: "0x4200000000000000000000000000000000000006",
      pool: "0x6c561B446416E1A00E8E93E221854d6eA4171372",
      oracleType: "uniswap",
    },
    {
      symbol: "USDC",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      pool: "0x6c561B446416E1A00E8E93E221854d6eA4171372",
      oracleType: "uniswap",
    },
    {
      symbol: "cbBTC",
      token: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      pool: "0x4e962BB3889Bf030368F56810A9c96B83CB3E778",
      oracleType: "aerodrome",
    },
    {
      symbol: "wstETH",
      token: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
      pool: "0x861A2922bE165a5Bd41b1E482B49216b465e1B5F",
      oracleType: "aerodrome",
    },
  ],
};
