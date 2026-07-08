import { ethers } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

/**
 * Deploys only the new DeviationSentinel implementation contract.
 * Does NOT touch the proxy — proxy upgrade is handled via governance VIP.
 */
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying new DeviationSentinel implementation with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const eBrakeAddress = await getContractAddressOrNullAddress(deployments, "EBrake");

  if (eBrakeAddress === ethers.constants.AddressZero) {
    console.log("EBrake not deployed, skipping DeviationSentinel implementation deployment");
    return;
  }

  const resilientOracle = ADDRESSES.preconfiguredAddresses.ResilientOracle;
  const sentinelOracle = await hre.ethers.getContract("SentinelOracle");

  const constructorArgs = [eBrakeAddress, resilientOracle, sentinelOracle.address];

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
func.dependencies = ["ebrake", "sentinel"];
