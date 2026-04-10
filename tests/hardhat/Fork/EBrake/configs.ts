// ═══════════════════════════════════════════════════════════════════════════
// EBrake Fork Test — Network Configurations
// ═══════════════════════════════════════════════════════════════════════════

export type ComptrollerType = "diamond" | "il";

export interface EmodeConfig {
  poolId: number;
  vToken: string;
  unlistedPoolId: number;
  unlistedVToken: string;
}

export interface NetworkConfig {
  networkName: string;
  label: string;
  forkBlock: number;
  comptroller: string;
  timelock: string;
  acm: string;
  vToken1: string;
  vToken2: string;
  comptrollerType: ComptrollerType;
  isIsolatedPool: boolean;
  comptrollerAbi: string[];
  comptrollerPermissions: string[];
  eBrakeFunctions: string[];
  emodeConfig?: EmodeConfig;
}

// ── Shared ABIs ──

const DIAMOND_COMPTROLLER_ABI = [
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
  "function poolMarkets(uint96 poolId, address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function setActionsPaused(address[] calldata markets, uint8[] calldata actions, bool paused)",
  "function setFlashLoanPaused(bool paused)",
  "function flashLoanPaused() view returns (bool)",
  "function setIsBorrowAllowed(uint96 poolId, address vToken, bool borrowAllowed)",
  "function setWhiteListFlashLoanAccount(address account, bool isWhiteListed)",
  "function authorizedFlashLoan(address account) view returns (bool)",
  "function lastPoolId() view returns (uint96)",
];

const IL_COMPTROLLER_ABI = [
  "function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, uint256 liquidationThresholdMantissa)",
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
];

// ── Shared permission sets ──

const DIAMOND_COMPTROLLER_PERMISSIONS = [
  "_setActionsPaused(address[],uint8[],bool)",
  "setCollateralFactor(uint96,address,uint256,uint256)",
  "_setMarketBorrowCaps(address[],uint256[])",
  "_setMarketSupplyCaps(address[],uint256[])",
  "setFlashLoanPaused(bool)",
  "setIsBorrowAllowed(uint96,address,bool)",
  "setWhiteListFlashLoanAccount(address,bool)",
];

const IL_COMPTROLLER_PERMISSIONS = [
  "setActionsPaused(address[],uint8[],bool)",
  "setCollateralFactor(address,uint256,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
];

const DIAMOND_EBRAKE_FUNCTIONS = [
  "pauseActions(address[],uint8[])",
  "pauseSupply(address)",
  "pauseRedeem(address)",
  "pauseBorrow(address)",
  "pauseTransfer(address)",
  "pauseFlashLoan()",
  "disablePoolBorrow(uint96,address)",
  "revokeFlashLoanAccess(address)",
  "decreaseCF(address,uint256)",
  "decreaseCF(address,uint96,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
  "resetCFSnapshot(address)",
  "resetBorrowCapSnapshot(address)",
  "resetSupplyCapSnapshot(address)",
];

const IL_EBRAKE_FUNCTIONS = [
  "pauseActions(address[],uint8[])",
  "pauseSupply(address)",
  "pauseRedeem(address)",
  "pauseBorrow(address)",
  "pauseTransfer(address)",
  "decreaseCF(address,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
  "resetCFSnapshot(address)",
  "resetBorrowCapSnapshot(address)",
  "resetSupplyCapSnapshot(address)",
];

// ═══════════════════════════════════════════════════════════════════════════
// NETWORK CONFIGS
// ═══════════════════════════════════════════════════════════════════════════

export const bscmainnetConfig: NetworkConfig = {
  networkName: "bscmainnet",
  label: "BSC Mainnet",
  forkBlock: 89587508,
  comptroller: "0xfd36e2c2a6789db23113685031d7f16329158384",
  timelock: "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396",
  acm: "0x4788629abc6cfca10f9f969efdeaa1cf70c23555",
  vToken1: "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B", // vBTCB
  vToken2: "0xfD5840Cd36d94D7229439859C0112a4185BC0255", // vUSDT
  comptrollerType: "diamond",
  isIsolatedPool: false,
  comptrollerAbi: DIAMOND_COMPTROLLER_ABI,
  comptrollerPermissions: DIAMOND_COMPTROLLER_PERMISSIONS,
  eBrakeFunctions: DIAMOND_EBRAKE_FUNCTIONS,
  emodeConfig: {
    poolId: 4,
    vToken: "0xfD5840Cd36d94D7229439859C0112a4185BC0255", // vUSDT listed in pool 4
    unlistedPoolId: 1,
    unlistedVToken: "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B", // vBTCB not listed in pool 1
  },
};

export const ethereumConfig: NetworkConfig = {
  networkName: "ethereum",
  label: "Ethereum Mainnet",
  forkBlock: 24770919,
  comptroller: "0x687a01ecF6d3907658f7A7c714749fAC32336D1B",
  timelock: "0xd969E79406c35E80750aAae061D402Aab9325714",
  acm: "0x230058da2D23eb8836EC5DB7037ef7250c56E25E",
  vToken1: "0x7c8ff7d2A1372433726f879BD945fFb250B94c65", // vWETH_Core
  vToken2: "0x17C07e0c232f2f80DfDbd7a95b942D893A4C5ACb", // vUSDC_Core
  comptrollerType: "il",
  isIsolatedPool: true,
  comptrollerAbi: IL_COMPTROLLER_ABI,
  comptrollerPermissions: IL_COMPTROLLER_PERMISSIONS,
  eBrakeFunctions: IL_EBRAKE_FUNCTIONS,
};

export const arbitrumoneConfig: NetworkConfig = {
  networkName: "arbitrumone",
  label: "Arbitrum One",
  forkBlock: 447543688,
  comptroller: "0x317c1A5739F39046E20b08ac9BeEa3f10fD43326",
  timelock: "0x4b94589Cc23F618687790036726f744D602c4017",
  acm: "0xD9dD18EB0cf10CbA837677f28A8F9Bda4bc2b157",
  vToken1: "0x68a34332983f4Bf866768DD6D6E638b02eF5e1f0", // vWETH_Core
  vToken2: "0x7D8609f8da70fF9027E9bc5229Af4F6727662707", // vUSDC_Core
  comptrollerType: "il",
  isIsolatedPool: true,
  comptrollerAbi: IL_COMPTROLLER_ABI,
  comptrollerPermissions: IL_COMPTROLLER_PERMISSIONS,
  eBrakeFunctions: IL_EBRAKE_FUNCTIONS,
};

export const basemainnetConfig: NetworkConfig = {
  networkName: "basemainnet",
  label: "Base Mainnet",
  forkBlock: 44081996,
  comptroller: "0x0C7973F9598AA62f9e03B94E92C967fD5437426C",
  timelock: "0x21c12f2946a1a66cBFf7eb997022a37167eCf517",
  acm: "0x9E6CeEfDC6183e4D0DF8092A9B90cDF659687daB",
  vToken1: "0x133d3BCD77158D125B75A17Cb517fFD4B4BE64C5", // vwstETH
  vToken2: "0x3cb752d175740043Ec463673094e06ACDa2F9a2e", // vUSDC_Core
  comptrollerType: "il",
  isIsolatedPool: true,
  comptrollerAbi: IL_COMPTROLLER_ABI,
  comptrollerPermissions: IL_COMPTROLLER_PERMISSIONS,
  eBrakeFunctions: IL_EBRAKE_FUNCTIONS,
};

export const opmainnetConfig: NetworkConfig = {
  networkName: "opmainnet",
  label: "OP Mainnet",
  forkBlock: 149677281,
  comptroller: "0x5593FF68bE84C966821eEf5F0a988C285D5B7CeC",
  timelock: "0x0C6f1E6B4fDa846f63A0d5a8a73EB811E0e0C04b",
  acm: "0xD71b1F33f6B0259683f11174EE4Ddc2bb9cE4eD6",
  vToken1: "0x37ac9731B0B02df54975cd0c7240e0977a051721", // vUSDT_Core
  vToken2: "0x66d5AE25731Ce99D46770745385e662C8e0B4025", // vWETH_Core
  comptrollerType: "il",
  isIsolatedPool: true,
  comptrollerAbi: IL_COMPTROLLER_ABI,
  comptrollerPermissions: IL_COMPTROLLER_PERMISSIONS,
  eBrakeFunctions: IL_EBRAKE_FUNCTIONS,
};

export const opbnbmainnetConfig: NetworkConfig = {
  networkName: "opbnbmainnet",
  label: "opBNB Mainnet",
  forkBlock: 127345640,
  comptroller: "0xD6e3E2A1d8d95caE355D15b3b9f8E5c2511874dd",
  timelock: "0x10f504e939b912569Dca611851fDAC9E3Ef86819",
  acm: "0xA60Deae5344F1152426cA440fb6552eA0e3005D6",
  vToken1: "0x509e81eF638D489936FA85BC58F52Df01190d26C", // vETH_Core
  vToken2: "0xb7a01Ba126830692238521a1aA7E7A7509410b8e", // vUSDT_Core
  comptrollerType: "il",
  isIsolatedPool: true,
  comptrollerAbi: IL_COMPTROLLER_ABI,
  comptrollerPermissions: IL_COMPTROLLER_PERMISSIONS,
  eBrakeFunctions: IL_EBRAKE_FUNCTIONS,
};

export const unichainmainnetConfig: NetworkConfig = {
  networkName: "unichainmainnet",
  label: "Unichain Mainnet",
  forkBlock: 44206481,
  comptroller: "0xe22af1e6b78318e1Fe1053Edbd7209b8Fc62c4Fe",
  timelock: "0x918532A78d22419Da4091930d472bDdf532BE89a",
  acm: "0x1f12014c497a9d905155eB9BfDD9FaC6885e61d0",
  vToken1: "0xbEC19Bef402C697a7be315d3e59E5F65b89Fa1BB", // vwstETH
  vToken2: "0xB953f92B9f759d97d2F2Dec10A8A3cf75fcE3A95", // vUSDC_Core
  comptrollerType: "il",
  isIsolatedPool: true,
  comptrollerAbi: IL_COMPTROLLER_ABI,
  comptrollerPermissions: IL_COMPTROLLER_PERMISSIONS,
  eBrakeFunctions: IL_EBRAKE_FUNCTIONS,
};
