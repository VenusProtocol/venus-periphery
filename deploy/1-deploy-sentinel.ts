import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying Sentinel contracts with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = ADDRESSES.preconfiguredAddresses.NormalTimelock;
  const resilientOracle = ADDRESSES.preconfiguredAddresses.ResilientOracle;

  const pancakeSwapOracleResult = await deploy("PancakeSwapOracle", {
    contract: "PancakeSwapOracle",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [resilientOracle],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
  });

  if (pancakeSwapOracleResult.newlyDeployed) {
    await hre.run("verify:verify", {
      address: pancakeSwapOracleResult.implementation,
      constructorArguments: [resilientOracle],
    });
  }

  const uniswapOracleResult = await deploy("UniswapOracle", {
    contract: "UniswapOracle",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [resilientOracle],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
  });

  if (uniswapOracleResult.newlyDeployed) {
    await hre.run("verify:verify", {
      address: uniswapOracleResult.implementation,
      constructorArguments: [resilientOracle],
    });
  }

  const sentinelOracleResult = await deploy("SentinelOracle", {
    contract: "SentinelOracle",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
  });

  if (sentinelOracleResult.newlyDeployed) {
    await hre.run("verify:verify", {
      address: sentinelOracleResult.implementation,
      constructorArguments: [],
    });
  }

  const sentinelOracle = await hre.ethers.getContract("SentinelOracle");
  const eBrakeAddress = await getContractAddressOrNullAddress(deployments, "EBrake");

  if (eBrakeAddress === "0x0000000000000000000000000000000000000000") {
    console.log("EBrake not deployed, skipping DeviationSentinel deployment");
    return;
  }

  const deviationSentinelResult = await deploy("DeviationSentinel", {
    contract: "DeviationSentinel",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [eBrakeAddress, resilientOracle, sentinelOracle.address],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
  });

  if (deviationSentinelResult.newlyDeployed) {
    await hre.run("verify:verify", {
      address: deviationSentinelResult.implementation,
      constructorArguments: [eBrakeAddress, resilientOracle, sentinelOracle.address],
    });
  }

  const deviationSentinel = await hre.ethers.getContract("DeviationSentinel");
  const uniswapOracle = await hre.ethers.getContract("UniswapOracle");
  const pancakeSwapOracle = await hre.ethers.getContract("PancakeSwapOracle");

  if (
    network.live &&
    (await sentinelOracle.owner()) === deployer &&
    (await sentinelOracle.pendingOwner()) !== timelock
  ) {
    await sentinelOracle.transferOwnership(timelock);
  }

  if (
    network.live &&
    (await deviationSentinel.owner()) === deployer &&
    (await deviationSentinel.pendingOwner()) !== timelock
  ) {
    await deviationSentinel.transferOwnership(timelock);
  }

  if ((await uniswapOracle.owner()) === deployer && (await uniswapOracle.pendingOwner()) !== timelock) {
    await uniswapOracle.transferOwnership(timelock);
  }

  if ((await pancakeSwapOracle.owner()) === deployer && (await pancakeSwapOracle.pendingOwner()) !== timelock) {
    await pancakeSwapOracle.transferOwnership(timelock);
  }
};

export default func;
func.tags = ["sentinel"];
func.dependencies = ["ebrake"];
