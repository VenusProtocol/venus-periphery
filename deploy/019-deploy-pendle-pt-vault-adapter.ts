import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

interface AdminAccounts {
  [key: string]: string;
}

// BSC Mainnet addresses
const PENDLE_ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const adminAccount: AdminAccounts = {
    hardhat: deployer,
    bsctestnet: await getContractAddressOrNullAddress(deployments, "NormalTimelock"),
    bscmainnet: await getContractAddressOrNullAddress(deployments, "NormalTimelock"),
  };

  const owner = network.name === "hardhat" ? deployer : adminAccount[network.name];

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  await deploy("PendlePTVaultAdapter", {
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [PENDLE_ROUTER, WBNB],
    proxy: {
      owner: owner,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [owner],
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });
};

func.tags = ["PendlePTVaultAdapter"];

func.skip = async (hre: HardhatRuntimeEnvironment) => {
  return hre.network.name !== "bscmainnet" && hre.network.name !== "bsctestnet" && hre.network.name !== "hardhat";
};

export default func;
