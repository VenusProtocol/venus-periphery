import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig } from "../helpers/deploymentConfig";

/**
 * Deploys only the new DeviationSentinel implementation contract.
 * Does NOT touch the proxy — proxy upgrade is handled via governance VIP.
 */
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying new DeviationSentinel implementation with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const resilientOracle = ADDRESSES.preconfiguredAddresses.ResilientOracle;
  const eBrake = await hre.ethers.getContract("EBrake");
  const sentinelOracle = await hre.ethers.getContract("SentinelOracle");

  const constructorArgs = [eBrake.address, resilientOracle, sentinelOracle.address];

  const result = await deploy("DeviationSentinel_Implementation", {
    contract: "DeviationSentinel",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: constructorArgs,
  });

  console.log(`New DeviationSentinel implementation deployed at: ${result.address}`);
  console.log(`Proxy upgrade to this implementation must be done via governance VIP`);

  if (result.newlyDeployed) {
    console.log("Verifying DeviationSentinel implementation on explorer...");
    await hre.run("verify:verify", {
      address: result.address,
      constructorArguments: constructorArgs,
    });
  }
};

export default func;
func.tags = ["sentinel-impl"];
