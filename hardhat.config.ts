import "module-alias/register";

import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-toolbox";
import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-etherscan";
import "@openzeppelin/hardhat-upgrades";
import "@typechain/hardhat";
import * as dotenv from "dotenv";
import "hardhat-dependency-compiler";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import { HardhatUserConfig, extendConfig, extendEnvironment, task } from "hardhat/config";
import { HardhatConfig } from "hardhat/types";
import "solidity-coverage";
import "solidity-docgen";

dotenv.config();
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const getRpcUrl = (networkName: string): string => {
  let uri;
  if (networkName) {
    uri = process.env[`ARCHIVE_NODE_${networkName}`];
  }
  if (!uri) {
    throw new Error(`invalid uri or network not supported by node provider : ${uri}`);
  }
  return uri;
};

extendEnvironment(hre => {
  hre.getNetworkName = () => process.env.HARDHAT_FORK_NETWORK || hre.network.name;
});

extendConfig((config: HardhatConfig) => {
  if (process.env.EXPORT !== "true") {
    config.external = {
      ...config.external,
      deployments: {
        hardhat: [],
        bsctestnet: ["node_modules/@venusprotocol/venus-protocol/deployments/bsctestnet"],
        bscmainnet: ["node_modules/@venusprotocol/venus-protocol/deployments/bscmainnet"],
        unichainmainnet: ["node_modules/@venusprotocol/venus-protocol/deployments/unichainmainnet"],
      },
    };
    if (process.env.HARDHAT_FORK_NETWORK) {
      config.external.deployments!.hardhat = [
        `./deployments/${process.env.HARDHAT_FORK_NETWORK}`,
        `node_modules/@venusprotocol/venus-protocol/deployments/${process.env.HARDHAT_FORK_NETWORK}`,
      ];
    }
  }
});

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.25",
        settings: {
          optimizer: {
            enabled: true,
            details: {
              yul: !process.env.CI,
            },
          },
          evmVersion: "cancun",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      {
        version: "0.5.16",
        settings: {
          optimizer: {
            enabled: true,
            details: {
              yul: !process.env.CI,
            },
          },
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      loggingEnabled: false,
      live: !!process.env.HARDHAT_FORK_NETWORK,
      forking: process.env.HARDHAT_FORK_NETWORK
        ? {
            url: getRpcUrl(process.env.HARDHAT_FORK_NETWORK),
            blockNumber: process.env.HARDHAT_FORK_NUMBER ? parseInt(process.env.HARDHAT_FORK_NUMBER) : undefined,
          }
        : undefined,
    },
    development: {
      url: "http://127.0.0.1:8545/",
      chainId: 31337,
      live: false,
    },
    bsctestnet: {
      url: process.env.ARCHIVE_NODE_bsctestnet || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      live: true,
      tags: ["testnet"],
      gasPrice: 20000000000,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : [],
    },
    // Mainnet deployments are done through Frame wallet RPC
    bscmainnet: {
      url: process.env.ARCHIVE_NODE_bscmainnet || "https://bsc-dataseed.binance.org/",
      chainId: 56,
      live: true,
      timeout: 1200000,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : [],
    },
    ethereum: {
      url: process.env.ARCHIVE_NODE_ethereum || "https://ethereum.blockpi.network/v1/rpc/public",
      chainId: 1,
      live: true,
      timeout: 1200000, // 20 minutes
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : [],
    },
    sepolia: {
      url: process.env.ARCHIVE_NODE_sepolia || "https://ethereum-sepolia.blockpi.network/v1/rpc/public",
      chainId: 11155111,
      live: true,
      tags: ["testnet"],
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : [],
    },
    opbnbtestnet: {
      url: process.env.ARCHIVE_NODE_opbnbtestnet || "https://opbnb-testnet-rpc.bnbchain.org",
      chainId: 5611,
      live: true,
      tags: ["testnet"],
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    opbnbmainnet: {
      url: process.env.ARCHIVE_NODE_opbnbmainnet || "https://opbnb-mainnet-rpc.bnbchain.org",
      chainId: 204,
      live: true,
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    arbitrumsepolia: {
      url: process.env.ARCHIVE_NODE_arbitrumsepolia || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      live: true,
      tags: ["testnet"],
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    arbitrumone: {
      url: process.env.ARCHIVE_NODE_arbitrumone || "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      live: true,
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    opsepolia: {
      url: process.env.ARCHIVE_NODE_opsepolia || "https://sepolia.optimism.io",
      chainId: 11155420,
      live: true,
      tags: ["testnet"],
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    opmainnet: {
      url: process.env.ARCHIVE_NODE_opmainnet || "https://mainnet.optimism.io",
      chainId: 10,
      live: true,
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    basesepolia: {
      url: process.env.ARCHIVE_NODE_basesepolia || "https://sepolia.base.org",
      chainId: 84532,
      live: true,
      tags: ["testnet"],
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    basemainnet: {
      url: process.env.ARCHIVE_NODE_basemainnet || "https://mainnet.base.org",
      chainId: 8453,
      live: true,
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    unichainsepolia: {
      url: process.env.ARCHIVE_NODE_unichainsepolia || "https://sepolia.unichain.org",
      chainId: 1301,
      live: true,
      tags: ["testnet"],
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
    unichainmainnet: {
      url: process.env.ARCHIVE_NODE_unichainmainnet || "https://mainnet.unichain.org",
      chainId: 130,
      live: true,
      accounts: DEPLOYER_PRIVATE_KEY ? [`0x${DEPLOYER_PRIVATE_KEY}`] : [],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  etherscan: {
    customChains: [
      {
        network: "bsctestnet",
        chainId: 97,
        urls: {
          apiURL: "https://api-testnet.bscscan.com/api",
          browserURL: "https://testnet.bscscan.com",
        },
      },
      {
        network: "bscmainnet",
        chainId: 56,
        urls: {
          apiURL: "https://api.bscscan.com/api",
          browserURL: "https://bscscan.com",
        },
      },
      {
        network: "sepolia",
        chainId: 11155111,
        urls: {
          apiURL: "https://api-sepolia.etherscan.io/api",
          browserURL: "https://sepolia.etherscan.io",
        },
      },
      {
        network: "ethereum",
        chainId: 1,
        urls: {
          apiURL: "https://api.etherscan.io/api",
          browserURL: "https://etherscan.io",
        },
      },
      {
        network: "opbnbtestnet",
        chainId: 5611,
        urls: {
          apiURL: `https://open-platform.nodereal.io/${process.env.ETHERSCAN_API_KEY}/op-bnb-testnet/contract/`,
          browserURL: "https://testnet.opbnbscan.com/",
        },
      },
      {
        network: "opbnbmainnet",
        chainId: 204,
        urls: {
          apiURL: `https://open-platform.nodereal.io/${process.env.ETHERSCAN_API_KEY}/op-bnb-mainnet/contract/`,
          browserURL: "https://opbnbscan.com/",
        },
      },
      {
        network: "ethereum",
        chainId: 1,
        urls: {
          apiURL: "https://api.etherscan.io/api",
          browserURL: "https://etherscan.io",
        },
      },
      {
        network: "arbitrumsepolia",
        chainId: 421614,
        urls: {
          apiURL: `https://api-sepolia.arbiscan.io/api`,
          browserURL: "https://sepolia.arbiscan.io/",
        },
      },
      {
        network: "arbitrumone",
        chainId: 42161,
        urls: {
          apiURL: `https://api.arbiscan.io/api/`,
          browserURL: "https://arbiscan.io/",
        },
      },
      {
        network: "opsepolia",
        chainId: 11155420,
        urls: {
          apiURL: "https://api-sepolia-optimistic.etherscan.io/api/",
          browserURL: "https://sepolia-optimistic.etherscan.io/",
        },
      },
      {
        network: "opmainnet",
        chainId: 10,
        urls: {
          apiURL: "https://api-optimistic.etherscan.io/api",
          browserURL: "https://optimistic.etherscan.io/",
        },
      },
      {
        network: "basesepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org/",
        },
      },
      {
        network: "basemainnet",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org/",
        },
      },
      {
        network: "unichainsepolia",
        chainId: 1301,
        urls: {
          apiURL: "https://api-sepolia.uniscan.xyz/api/",
          browserURL: "https://sepolia.uniscan.xyz/",
        },
      },
      {
        network: "unichainmainnet",
        chainId: 130,
        urls: {
          apiURL: "https://api.uniscan.xyz/api/",
          browserURL: "https://uniscan.xyz/",
        },
      },
    ],
    apiKey: {
      bscmainnet: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      bsctestnet: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      ethereum: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      sepolia: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      opbnbmainnet: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      opbnbtestnet: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      arbitrumone: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      arbitrumsepolia: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      opsepolia: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      opmainnet: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      basesepolia: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      basemainnet: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      unichainsepolia: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
      unichainmainnet: process.env.ETHERSCAN_API_KEY || "ETHERSCAN_API_KEY",
    },
  },
  paths: {
    tests: "./tests",
  },
  // Hardhat deploy
  namedAccounts: {
    deployer: 0,
    acc1: 1,
    acc2: 2,
    proxyAdmin: 3,
    acc3: 4,
  },
  docgen: {
    outputDir: "./docs",
    pages: "files",
    templates: "./docgen-templates",
  },
  external: {
    contracts: [
      {
        artifacts: "node_modules/@venusprotocol/venus-protocol/artifacts",
      },
    ],
  },
  dependencyCompiler: {
    paths: [
      "hardhat-deploy/solc_0.8/proxy/OptimizedTransparentUpgradeableProxy.sol",
      "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol",
    ],
  },
};

export default config;
