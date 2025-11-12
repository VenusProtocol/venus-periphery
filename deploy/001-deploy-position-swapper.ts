import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
  const vBNBDeployment = await deployments.get("vBNB");
   const vWBNBDeploymentAddress = "0x6bCa74586218dB34cdB402295796b79663d816e9";

  const comptrollerDeployment = await deployments.get("Unitroller");
  const timelock = await deployments.get("NormalTimelock");

  // Explicitly mentioning Default Proxy Admin contract path to fetch it from hardhat-deploy instead of OpenZeppelin
  // as zksync doesnot compile OpenZeppelin contracts using zksolc. It is backward compatible for all networks as well.
  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const swapHelper = await ethers.getContract("SwapHelper");

  await deploy("PositionSwapper", {
    from: deployer,
    log: true,
    args: [comptrollerDeployment.address, swapHelper.address, WBNB_ADDRESS, vBNBDeployment.address, vWBNBDeploymentAddress],
    proxy: {
      owner: network.name === "hardhat" ? deployer : timelock.address,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [],
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });
};

func.tags = ["PositionSwapper"];
// func.skip = async hre => hre.network.name === "hardhat";

export default func;
