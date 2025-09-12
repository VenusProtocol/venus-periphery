import { contracts as bscmainnet } from "@venusprotocol/governance-contracts/deployments/bscmainnet.json";
import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

interface VTokenConfig {
  name: string;
  address: string;
}

const VWNativeInfo: { [key: string]: VTokenConfig[] } = {
  bsctestnet: [
    {
      name: "vWBNB_Core",
      address: "0xd9E77847ec815E56ae2B9E69596C69b6972b0B1C",
    },
  ],
  bscmainnet: [
    {
      name: "vWBNB_Core",
      address: "0x6bCa74586218dB34cdB402295796b79663d816e9",
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
  const timelockAddress = bscmainnet.NormalTimelock.address;

  const vWNativesInfo = getVWNativeTokens(hre.getNetworkName());
  for (const vWNativeInfo of vWNativesInfo) {
    await deploy(`NativeTokenGateway_${vWNativeInfo.name}`, {
      contract: "contracts/Gateway/NativeTokenGatewayCore.sol:NativeTokenGateway",
      from: deployer,
      args: [vWNativeInfo.address],
      log: true,
      autoMine: true,
      skipIfAlreadyDeployed: false,
    });

    const nativeTokenGateway = await ethers.getContract(`NativeTokenGateway_${vWNativeInfo.name}`);
    const targetOwner = timelockAddress || deployer;
    if (hre.network.live && (await nativeTokenGateway.owner()) !== targetOwner) {
      const tx = await nativeTokenGateway.transferOwnership(targetOwner);
      await tx.wait();
      console.log(`Transferred ownership of NativeTokenGateway_${vWNativeInfo.name} to Timelock`);
    }
  }
};

func.tags = ["NativeTokenGatewayCore"];

func.skip = async (hre: HardhatRuntimeEnvironment) => !hre.network.live;

export default func;
