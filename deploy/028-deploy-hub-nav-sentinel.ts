import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying HubNavDeviationSentinel with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = ADDRESSES.preconfiguredAddresses.NormalTimelock;
  const hubRegistry = ADDRESSES.preconfiguredAddresses.HubRegistry;
  const eBrakeAddress = await getContractAddressOrNullAddress(deployments, "EBrake");

  // Only BSC runs a Liquidity Hub, so there is nothing to watch elsewhere.
  if (!hubRegistry) {
    console.log("No HubRegistry configured, skipping HubNavDeviationSentinel deployment");
    return;
  }

  if (eBrakeAddress === hre.ethers.constants.AddressZero) {
    console.log("EBrake not deployed, skipping HubNavDeviationSentinel deployment");
    return;
  }

  const result = await deploy("HubNavDeviationSentinel", {
    contract: "HubNavDeviationSentinel",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [eBrakeAddress, hubRegistry],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
  });

  if (result.newlyDeployed && network.live) {
    await hre.run("verify:verify", {
      address: result.implementation,
      constructorArguments: [eBrakeAddress, hubRegistry],
    });
  }

  const sentinel = await hre.ethers.getContract("HubNavDeviationSentinel");
  if (network.live && (await sentinel.owner()) === deployer && (await sentinel.pendingOwner()) !== timelock) {
    await sentinel.transferOwnership(timelock);
  }
};

export default func;
func.tags = ["hub-nav-sentinel"];
func.dependencies = ["ebrake"];
