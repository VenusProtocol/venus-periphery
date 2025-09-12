import { contracts as ilArbOne } from "@venusprotocol/isolated-pools/deployments/arbitrumone.json";
import { contracts as ilArbSepolia } from "@venusprotocol/isolated-pools/deployments/arbitrumsepolia.json";
import { contracts as ilBaseMainnet } from "@venusprotocol/isolated-pools/deployments/basemainnet.json";
import { contracts as ilBaseSepolia } from "@venusprotocol/isolated-pools/deployments/basesepolia.json";
import { contracts as ilBscMainnet } from "@venusprotocol/isolated-pools/deployments/bscmainnet.json";
import { contracts as ilBscTestnet } from "@venusprotocol/isolated-pools/deployments/bsctestnet.json";
import { contracts as ilEthereum } from "@venusprotocol/isolated-pools/deployments/ethereum.json";
import { contracts as ilOpbnbMainnet } from "@venusprotocol/isolated-pools/deployments/opbnbmainnet.json";
import { contracts as ilOpbnbTestnet } from "@venusprotocol/isolated-pools/deployments/opbnbtestnet.json";
import { contracts as ilOpMainnet } from "@venusprotocol/isolated-pools/deployments/opmainnet.json";
import { contracts as ilOpSepolia } from "@venusprotocol/isolated-pools/deployments/opsepolia.json";
import { contracts as ilSepolia } from "@venusprotocol/isolated-pools/deployments/sepolia.json";
import { contracts as ilUnichainMainnet } from "@venusprotocol/isolated-pools/deployments/unichainmainnet.json";
import { contracts as ilUnichainSepolia } from "@venusprotocol/isolated-pools/deployments/unichainsepolia.json";
import { contracts as ilZkMainnet } from "@venusprotocol/isolated-pools/deployments/zksyncmainnet.json";
import { contracts as ilZkSepolia } from "@venusprotocol/isolated-pools/deployments/zksyncsepolia.json";
import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig } from "../helpers/deploymentConfig";

interface VTokenConfig {
  name: string;
  address: string;
}

const VWNativeInfo: { [key: string]: VTokenConfig[] } = {
  bsctestnet: [
    {
      name: "vWBNB_LiquidStakedBNB",
      address: ilBscTestnet.VToken_vWBNB_LiquidStakedBNB.address,
    },
  ],
  bscmainnet: [
    {
      name: "vWBNB_LiquidStakedBNB",
      address: ilBscMainnet.VToken_vWBNB_LiquidStakedBNB.address,
    },
  ],
  sepolia: [
    {
      name: "vWETH_Core",
      address: ilSepolia.VToken_vWETH_Core.address,
    },
    {
      name: "vWETH_LiquidStakedETH",
      address: ilSepolia.VToken_vWETH_LiquidStakedETH.address,
    },
  ],
  ethereum: [
    {
      name: "vWETH_Core",
      address: ilEthereum.VToken_vWETH_Core.address,
    },
    {
      name: "vWETH_LiquidStakedETH",
      address: ilEthereum.VToken_vWETH_LiquidStakedETH.address,
    },
  ],
  opbnbtestnet: [
    {
      name: "vWBNB_Core",
      address: ilOpbnbTestnet.VToken_vWBNB_Core.address,
    },
  ],
  opbnbmainnet: [
    {
      name: "vWBNB_Core",
      address: ilOpbnbMainnet.VToken_vWBNB_Core.address,
    },
  ],
  arbitrumsepolia: [
    {
      name: "vWETH_Core",
      address: ilArbSepolia.VToken_vWETH_Core.address,
    },
    {
      name: "vWETH_LiquidStakedETH",
      address: ilArbSepolia.VToken_vWETH_LiquidStakedETH.address,
    },
  ],
  arbitrumone: [
    {
      name: "vWETH_Core",
      address: ilArbOne.VToken_vWETH_Core.address,
    },
    {
      name: "vWETH_LiquidStakedETH",
      address: ilArbOne.VToken_vWETH_LiquidStakedETH.address,
    },
  ],
  zksyncsepolia: [
    {
      name: "vWETH_Core",
      address: ilZkSepolia.VToken_vWETH_Core.address,
    },
  ],
  zksyncmainnet: [
    {
      name: "vWETH_Core",
      address: ilZkMainnet.VToken_vWETH_Core.address,
    },
  ],
  opsepolia: [
    {
      name: "vWETH_Core",
      address: ilOpSepolia.VToken_vWETH_Core.address,
    },
  ],
  opmainnet: [
    {
      name: "vWETH_Core",
      address: ilOpMainnet.VToken_vWETH_Core.address,
    },
  ],
  basesepolia: [
    {
      name: "vWETH_Core",
      address: ilBaseSepolia.VToken_vWETH_Core.address,
    },
  ],
  basemainnet: [
    {
      name: "vWETH_Core",
      address: ilBaseMainnet.VToken_vWETH_Core.address,
    },
  ],
  unichainsepolia: [
    {
      name: "vWETH_Core",
      address: ilUnichainSepolia.VToken_vWETH_Core.address,
    },
  ],
  unichainmainnet: [
    {
      name: "vWETH_Core",
      address: ilUnichainMainnet.VToken_vWETH_Core.address,
    },
  ],
};

const getVWNativeTokens = (networkName: string): VTokenConfig[] => {
  const vTokensInfo = VWNativeInfo[networkName];
  if (vTokensInfo === undefined) {
    throw new Error(`config for network ${networkName} is not available.`);
  }

  return vTokensInfo;
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const { preconfiguredAddresses } = await getConfig(hre.getNetworkName());

  const vWNativesInfo = getVWNativeTokens(hre.getNetworkName());
  for (const vWNativeInfo of vWNativesInfo) {
    await deploy(`NativeTokenGateway_${vWNativeInfo.name}`, {
      contract: "contracts/Gateway/NativeTokenGatewayIL.sol:NativeTokenGateway",
      from: deployer,
      args: [vWNativeInfo.address],
      log: true,
      autoMine: true,
      skipIfAlreadyDeployed: true,
    });

    const nativeTokenGateway = await ethers.getContract(`NativeTokenGateway_${vWNativeInfo.name}`);
    const targetOwner = preconfiguredAddresses.NormalTimelock || deployer;
    if (hre.network.live && (await nativeTokenGateway.owner()) !== targetOwner) {
      const tx = await nativeTokenGateway.transferOwnership(targetOwner);
      await tx.wait();
      console.log(`Transferred ownership of NativeTokenGateway_${vWNativeInfo.name} to Timelock`);
    }
  }
};

func.tags = ["NativeTokenGatewayIL"];

func.skip = async (hre: HardhatRuntimeEnvironment) => !hre.network.live;

export default func;
