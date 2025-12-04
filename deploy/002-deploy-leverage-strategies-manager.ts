import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const comptrollerDeployment = await deployments.get("Unitroller");
  const timelock = await deployments.get("NormalTimelock");

  // Explicitly mentioning Default Proxy Admin contract path to fetch it from hardhat-deploy instead of OpenZeppelin
  // as zksync doesnot compile OpenZeppelin contracts using zksolc. It is backward compatible for all networks as well.
  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const swapHelperDeployment = await deployments.get("SwapHelper");
  const vBNBDeployment = await deployments.get("vBNB");

  await deploy("LeverageStrategiesManager", {
    from: deployer,
    log: true,
    args: [comptrollerDeployment.address, swapHelperDeployment.address, vBNBDeployment.address],
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

  const leverageStrategiesManager = await ethers.getContract("LeverageStrategiesManager");
  const owner = await leverageStrategiesManager.owner();

  console.log(
    `LeverageStrategiesManager verify arguments: ${leverageStrategiesManager.address} ${comptrollerDeployment.address} ${swapHelperDeployment.address} ${vBNBDeployment.address}`,
  );

  if (owner === deployer) {
    console.log("Transferring ownership to Normal Timelock ....");
    const tx = await leverageStrategiesManager.transferOwnership(timelock.address);
    await tx.wait();
    console.log("Ownership transferred to Normal Timelock");
  }
};
func.tags = ["LeverageManager"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
