import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const comptrollerDeployment = await deployments.get("Unitroller");

  await deploy("MarketConfigurationAggregator", {
    from: deployer,
    args: [comptrollerDeployment.address],
    log: true,
    skipIfAlreadyDeployed: true,
  });
};

func.tags = ["marketConfigurator"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
