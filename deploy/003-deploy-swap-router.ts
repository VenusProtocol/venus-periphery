import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const wBNBAddress = (await deployments.get("WBNB")).address;
  const vBNBDeployment = await deployments.get("vBNB");
  const comptrollerDeployment = await deployments.get("Unitroller");
  const timelock = await deployments.get("NormalTimelock");
  const swapHelper = await deployments.get("SwapHelper");

  // Explicitly mentioning Default Proxy Admin contract path to fetch it from hardhat-deploy instead of OpenZeppelin
  // as zksync doesnot compile OpenZeppelin contracts using zksolc. It is backward compatible for all networks as well.
  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  console.log(`Deploying SwapRouter on ${network.name}...`);
  await deploy("SwapRouter", {
    from: deployer,
    log: true,
    args: [comptrollerDeployment.address, swapHelper.address, wBNBAddress, vBNBDeployment.address],
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

  const swapRouter = await ethers.getContract("SwapRouter");

  if (network.name !== "hardhat") {
    if ((await swapRouter.owner()) === deployer) {
      console.log("Transferring SwapRouter ownership to Normal Timelock ....");
      const tx = await swapRouter.transferOwnership(timelock.address);
      await tx.wait();
      console.log("SwapRouter ownership transferred to Normal Timelock");
    }
  }
};

func.tags = ["SwapRouter"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
