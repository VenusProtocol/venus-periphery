export type ExecutorNetworkConfig = {
  isCorePool: boolean;
  signalCallers: string[];
};

export const EXECUTOR_CONFIG: Record<string, ExecutorNetworkConfig> = {
  hardhat: {
    isCorePool: true,
    signalCallers: [],
  },
  bsctestnet: {
    isCorePool: true,
    signalCallers: ["0x61859C84E0C6aB7B5A9801A962C660477f31a2D3"],
  },
  bscmainnet: {
    isCorePool: true,
    signalCallers: [],
  },
  sepolia: {
    isCorePool: false,
    signalCallers: [],
  },
  ethereum: {
    isCorePool: false,
    signalCallers: [],
  },
  opbnbtestnet: {
    isCorePool: false,
    signalCallers: [],
  },
  opbnbmainnet: {
    isCorePool: false,
    signalCallers: [],
  },
  arbitrumsepolia: {
    isCorePool: false,
    signalCallers: [],
  },
  arbitrumone: {
    isCorePool: false,
    signalCallers: [],
  },
  zksyncsepolia: {
    isCorePool: false,
    signalCallers: [],
  },
  zksyncmainnet: {
    isCorePool: false,
    signalCallers: [],
  },
  opsepolia: {
    isCorePool: false,
    signalCallers: [],
  },
  opmainnet: {
    isCorePool: false,
    signalCallers: [],
  },
  basesepolia: {
    isCorePool: false,
    signalCallers: [],
  },
  basemainnet: {
    isCorePool: false,
    signalCallers: [],
  },
  unichainsepolia: {
    isCorePool: false,
    signalCallers: [],
  },
  unichainmainnet: {
    isCorePool: false,
    signalCallers: [],
  },
};

export const EXECUTOR_HANDLER_SIGS: string[] = [
  "handleLTVAdjust(address,uint256)",
  "handleCapAdjust(address,uint8,uint256)",
  "handleSupplyCapExceeding(address)",
  "handleBorrowCapExceeding(address)",
];

export const EBRAKE_FUNCTIONS_FOR_EXECUTOR: string[] = [
  "decreaseCF(address,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
  "pauseSupply(address)",
  "pauseBorrow(address)",
];
