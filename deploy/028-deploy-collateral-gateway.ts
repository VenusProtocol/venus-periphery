import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying CollateralGateway with the account: ${deployer}`);

  const result = await deploy("CollateralGateway", {
    contract: "CollateralGateway",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [],
  });

  if (result.newlyDeployed && network.live) {
    await hre.run("verify:verify", {
      address: result.address,
      constructorArguments: [],
    });
  }
};

export default func;
func.tags = ["collateral-gateway"];
