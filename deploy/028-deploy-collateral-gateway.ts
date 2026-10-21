import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig } from "../helpers/deploymentConfig";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const { preconfiguredAddresses } = await getConfig(network.name);

  const poolRegistry = preconfiguredAddresses.SpokePoolRegistry;
  if (!poolRegistry) {
    console.log(`No SpokePoolRegistry configured for ${network.name}; skipping CollateralGateway deployment`);
    return;
  }

  console.log(`Deploying CollateralGateway with the account: ${deployer}`);

  const comptroller = await deployments.get("Unitroller");
  const timelock = await deployments.get("NormalTimelock");
  const owner = network.name === "hardhat" ? deployer : timelock.address;

  const result = await deploy("CollateralGateway", {
    contract: "CollateralGateway",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [comptroller.address, poolRegistry, owner],
  });

  if (result.newlyDeployed && network.live) {
    await hre.run("verify:verify", {
      address: result.address,
      constructorArguments: [comptroller.address, poolRegistry, owner],
    });
  }
};

export default func;
func.tags = ["collateral-gateway"];
func.skip = async hre => hre.network.name === "hardhat";
