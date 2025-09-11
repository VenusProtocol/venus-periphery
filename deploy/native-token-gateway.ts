import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { contracts as coreBscTestnet } from "../deployments/bsctestnet.json";

interface VTokenConfig {
  name: string;
  address: string;
}

const VWNativeInfo: { [key: string]: VTokenConfig[] } = {
  bsctestnet: [
    {
      name: "vWBNB",
      address: coreBscTestnet.vWBNB.address,
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
  const NormalTimelock = "0xce10739590001705F7FF231611ba4A48B2820327"; // BSC Testnet Normal Timelock

  const vWNativesInfo = getVWNativeTokens(hre.getNetworkName());
  for (const vWNativeInfo of vWNativesInfo) {
    await deploy(`NativeTokenGateway_${vWNativeInfo.name}`, {
      contract: "NativeTokenGateway",
      from: deployer,
      args: [vWNativeInfo.address],
      log: true,
      autoMine: true,
      skipIfAlreadyDeployed: true,
    });

    const nativeTokenGateway = await ethers.getContract(`NativeTokenGateway_${vWNativeInfo.name}`);
    const targetOwner = NormalTimelock || deployer;
    if (hre.network.live && (await nativeTokenGateway.owner()) !== targetOwner) {
      const tx = await nativeTokenGateway.transferOwnership(targetOwner);
      await tx.wait();
      console.log(`Transferred ownership of NativeTokenGateway_${vWNativeInfo.name} to Timelock`);
    }
  }
};

func.tags = ["NativeTokenGateway"];

func.skip = async (hre: HardhatRuntimeEnvironment) => !hre.network.live;

export default func;
