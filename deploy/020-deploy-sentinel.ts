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

  await deploy("PancakeSwapOracle", {
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

  await deploy("UniswapOracle", {
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

  await deploy("SentinelOracle", {
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

  const sentinelOracle = await hre.ethers.getContract("SentinelOracle");
  const eBrakeAddress = await getContractAddressOrNullAddress(deployments, "EBrake");

  if (eBrakeAddress === "0x0000000000000000000000000000000000000000") {
    console.log("EBrake not deployed, skipping DeviationSentinel deployment");
    return;
  }

  await deploy("DeviationSentinel", {
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

  const deviationSentinel = await hre.ethers.getContract("DeviationSentinel");
  const uniswapOracle = await hre.ethers.getContract("UniswapOracle");
  const pancakeSwapOracle = await hre.ethers.getContract("PancakeSwapOracle");

  if (network.live && (await sentinelOracle.owner()) == deployer) {
    await sentinelOracle.transferOwnership(timelock);
  }

  if (network.live && (await deviationSentinel.owner()) == deployer) {
    await deviationSentinel.transferOwnership(timelock);
  }

  if ((await uniswapOracle.owner()) == deployer) {
    await uniswapOracle.transferOwnership(timelock);
  }

  if ((await pancakeSwapOracle.owner()) == deployer) {
    await pancakeSwapOracle.transferOwnership(timelock);
  }
};

export default func;
func.tags = ["sentinel"];
func.dependencies = ["ebrake"];
