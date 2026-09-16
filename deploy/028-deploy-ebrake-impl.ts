import { ethers } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

/**
 * Deploys only the new EBrake implementation contract.
 * Does NOT touch the proxy — proxy upgrade is handled via governance VIP.
 *
 * Constructor args must match the live proxy's: EBrake's COMPTROLLER and IS_ISOLATED_POOL are
 * immutable, so a mismatch here silently repoints the brake at the wrong comptroller.
 */
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying new EBrake implementation with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const deployedUnitroller = await getContractAddressOrNullAddress(deployments, "Unitroller");
  const comptroller =
    deployedUnitroller !== ethers.constants.AddressZero
      ? deployedUnitroller
      : (ADDRESSES.preconfiguredAddresses.Unitroller ?? ethers.constants.AddressZero);

  if (comptroller === ethers.constants.AddressZero) {
    console.log("Unitroller not deployed, skipping EBrake implementation deployment");
    return;
  }

  // BSC (bsctestnet, bscmainnet) uses Diamond comptroller → isIsolatedPool = false
  // All other chains use IL comptroller → isIsolatedPool = true
  const isIsolatedPool = !network.name.startsWith("bsc") && network.name !== "hardhat";

  const constructorArgs = [comptroller, isIsolatedPool];

  const result = await deploy("EBrake_Implementation", {
    contract: "EBrake",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: constructorArgs,
  });

  console.log(`New EBrake implementation deployed at: ${result.address}`);
  console.log(`Proxy upgrade to this implementation must be done via governance VIP`);

  if (result.newlyDeployed && network.live) {
    console.log("Verifying EBrake implementation on explorer...");
    try {
      await hre.run("verify:verify", { address: result.address, constructorArguments: constructorArgs });
    } catch (e) {
      console.log(`verify failed: ${(e as Error).message}`);
    }
  }
};

export default func;
func.tags = ["ebrake-impl"];
func.dependencies = ["ebrake"];
