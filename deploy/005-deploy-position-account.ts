import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const comptrollerDeployment = await deployments.get("Unitroller");
  const leverageStrategiesManagerDeployment = await deployments.get("LeverageStrategiesManager");
  const relativePositionManagerDeployment = await deployments.get("RelativePositionManager");

  console.log(
    `Deploying PositionAccount on ${network.name} with Comptroller: ${comptrollerDeployment.address}, RelativePositionManager: ${relativePositionManagerDeployment.address}, LeverageStrategiesManager: ${leverageStrategiesManagerDeployment.address}`,
  );

  // Deploy PositionAccount implementation if not already deployed (used for EIP-1167 clones by RPM)
  const positionAccountDeployment = await deploy("PositionAccount", {
    from: deployer,
    log: true,
    waitConfirmations: 1,
    args: [
      comptrollerDeployment.address,
      relativePositionManagerDeployment.address,
      leverageStrategiesManagerDeployment.address,
    ],
    skipIfAlreadyDeployed: true,
  });

  console.log(
    `PositionAccount implementation deployed at ${positionAccountDeployment.address}. Set it on RPM via ACM (setPositionAccountImplementation).`,
  );
};

func.tags = ["PositionAccount"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
