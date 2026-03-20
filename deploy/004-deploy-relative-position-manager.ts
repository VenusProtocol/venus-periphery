import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const comptrollerDeployment = await deployments.get("Unitroller");
  const leverageStrategiesManagerDeployment = await deployments.get("LeverageStrategiesManager");
  const accessControlManagerDeployment = await deployments.get("AccessControlManager");
  const timelock = await deployments.get("NormalTimelock");

  // Explicitly mentioning Default Proxy Admin contract path to fetch it from hardhat-deploy instead of OpenZeppelin
  // as zksync does not compile OpenZeppelin contracts using zksolc. It is backward compatible for all networks as well.
  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  console.log(
    `Deploying RelativePositionManager on ${network.name} with Comptroller: ${comptrollerDeployment.address}, LeverageStrategiesManager: ${leverageStrategiesManagerDeployment.address}, AccessControlManager: ${accessControlManagerDeployment.address}`,
  );

  await deploy("RelativePositionManager", {
    from: deployer,
    log: true,
    waitConfirmations: 1,
    args: [comptrollerDeployment.address, leverageStrategiesManagerDeployment.address],
    proxy: {
      owner: network.name === "hardhat" ? deployer : timelock.address,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManagerDeployment.address],
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  const relativePositionManager = await ethers.getContract("RelativePositionManager");
  console.log(
    `RelativePositionManager deployed at ${relativePositionManager.address}. Verify: implementation constructor args (Comptroller, LeverageStrategiesManager) and initialize(AccessControlManager).`,
  );

  // Deploy PositionAccount implementation if not already deployed (used for EIP-1167 clones by RPM)
  const positionAccountDeployment = await deploy("PositionAccount", {
    from: deployer,
    log: true,
    waitConfirmations: 1,
    args: [comptrollerDeployment.address, relativePositionManager.address, leverageStrategiesManagerDeployment.address],
    skipIfAlreadyDeployed: true,
  });

  console.log(
    `PositionAccount implementation deployed at ${positionAccountDeployment.address}. Set it on RPM via ACM (setPositionAccountImplementation).`,
  );

  // Transfer RPM ownership to NormalTimelock if deployer is the current owner
  const owner = await relativePositionManager.owner();
  if (owner === deployer) {
    console.log("Transferring RelativePositionManager ownership to Normal Timelock ....");
    const tx = await (relativePositionManager as any).transferOwnership(timelock.address);
    await tx.wait();
    console.log("Call acceptOwnership() on the Normal Timelock to complete ownership transfer");
  }
};

func.tags = ["RelativePositionManager"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
