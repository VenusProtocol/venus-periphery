export type ExecutorNetworkConfig = {
  isCorePool: boolean;
  signalCallers: string[];
  // Additional addresses that should hold setMarketConfig permission on the Executor.
  // NormalTimelock is appended automatically at runtime from the deployments.
  extraConfigAdmins: string[];
  // Address expected to hold DEFAULT_ADMIN_ROLE on the ACM. Used by the ACM-config
  // script as a sanity check before printing calls for off-chain submission.
  // Leave empty to skip the check.
  expectedAcmAdmin: string;
};

export const EXECUTOR_CONFIG: Record<string, ExecutorNetworkConfig> = {
  hardhat: {
    isCorePool: true,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  bsctestnet: {
    isCorePool: true,
    signalCallers: ["0x61859C84E0C6aB7B5A9801A962C660477f31a2D3"],
    extraConfigAdmins: [
      "0x2Ce1d0ffD7E869D9DF33e28552b12DdDed326706", // multisig (ACM admin)
      "0x61859C84E0C6aB7B5A9801A962C660477f31a2D3", // Hashdit keeper
    ],
    expectedAcmAdmin: "0x2Ce1d0ffD7E869D9DF33e28552b12DdDed326706",
  },
  bscmainnet: {
    isCorePool: true,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  sepolia: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  ethereum: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  opbnbtestnet: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  opbnbmainnet: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  arbitrumsepolia: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  arbitrumone: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  zksyncsepolia: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  zksyncmainnet: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  opsepolia: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  opmainnet: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  basesepolia: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  basemainnet: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  unichainsepolia: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
  },
  unichainmainnet: {
    isCorePool: false,
    signalCallers: [],
    extraConfigAdmins: [],
    expectedAcmAdmin: "",
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

export const EXECUTOR_SET_MARKET_CONFIG_SIG = "setMarketConfig(address,(uint256,uint256,bool))";
