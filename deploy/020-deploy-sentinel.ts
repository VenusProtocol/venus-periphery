import { Contract } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

type SentinelContext = {
  deployments: HardhatRuntimeEnvironment["deployments"];
  network: HardhatRuntimeEnvironment["network"];
  deployer: string;
  timelock: string;
  accessControlManager: string;
};

/** Deploy `name` behind an OptimizedTransparentProxy, verifying it when newly deployed on a live network. */
async function deployProxied(ctx: SentinelContext, name: string, args: unknown[]): Promise<void> {
  const { deployments, network, deployer, timelock, accessControlManager } = ctx;
  const result = await deployments.deploy(name, {
    contract: name,
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args,
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
      constructorArguments: args,
    });
  }
}

/** Hand ownership to the timelock, but only while the deployer still holds it. */
async function transferOwnershipToTimelock(contract: Contract, deployer: string, timelock: string): Promise<void> {
  if ((await contract.owner()) === deployer && (await contract.pendingOwner()) !== timelock) {
    await contract.transferOwnership(timelock);
  }
}

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying Sentinel contracts with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = ADDRESSES.preconfiguredAddresses.NormalTimelock;
  const resilientOracle = ADDRESSES.preconfiguredAddresses.ResilientOracle;

  const ctx: SentinelContext = { deployments, network, deployer, timelock, accessControlManager };

  await deployProxied(ctx, "PancakeSwapOracle", [resilientOracle]);
  await deployProxied(ctx, "UniswapOracle", [resilientOracle]);
  await deployProxied(ctx, "SentinelOracle", []);

  const sentinelOracle = await hre.ethers.getContract("SentinelOracle");
  const eBrakeAddress = await getContractAddressOrNullAddress(deployments, "EBrake");

  if (eBrakeAddress === "0x0000000000000000000000000000000000000000") {
    console.log("EBrake not deployed, skipping DeviationSentinel deployment");
    return;
  }

  await deployProxied(ctx, "DeviationSentinel", [eBrakeAddress, resilientOracle, sentinelOracle.address]);

  const deviationSentinel = await hre.ethers.getContract("DeviationSentinel");
  const uniswapOracle = await hre.ethers.getContract("UniswapOracle");
  const pancakeSwapOracle = await hre.ethers.getContract("PancakeSwapOracle");

  if (network.live) {
    await transferOwnershipToTimelock(sentinelOracle, deployer, timelock);
    await transferOwnershipToTimelock(deviationSentinel, deployer, timelock);
  }

  await transferOwnershipToTimelock(uniswapOracle, deployer, timelock);
  await transferOwnershipToTimelock(pancakeSwapOracle, deployer, timelock);
};

export default func;
func.tags = ["sentinel"];
func.dependencies = ["ebrake"];
