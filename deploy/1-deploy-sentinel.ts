import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying Sentinel contracts with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const corePool = await getContractAddressOrNullAddress(deployments, "Unitroller");
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
      owner: timelock,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
    waitConfirmations: 2,
  });

  await deploy("UniswapOracle", {
    contract: "UniswapOracle",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [resilientOracle],
    proxy: {
      owner: timelock,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
    waitConfirmations: 2,
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
    waitConfirmations: network.live ? 2 : 1,
  });

  const sentinelOracle = await hre.ethers.getContract("SentinelOracle");

  await deploy("DeviationSentinel", {
    contract: "DeviationSentinel",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [corePool, resilientOracle, sentinelOracle.address],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
    },
    waitConfirmations: network.live ? 2 : 1,
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

  // Verify implementation contracts
  const pancakeSwapOracleImpl = await deployments.get("PancakeSwapOracle_Implementation");
  const uniswapOracleImpl = await deployments.get("UniswapOracle_Implementation");
  const sentinelOracleImpl = await deployments.get("SentinelOracle_Implementation");
  const deviationSentinelImpl = await deployments.get("DeviationSentinel_Implementation");

  await hre.run("verify:verify", {
    address: pancakeSwapOracleImpl.address,
    constructorArguments: [resilientOracle],
  });

  await hre.run("verify:verify", {
    address: uniswapOracleImpl.address,
    constructorArguments: [resilientOracle],
  });

  await hre.run("verify:verify", {
    address: sentinelOracleImpl.address,
    constructorArguments: [],
  });

  await hre.run("verify:verify", {
    address: deviationSentinelImpl.address,
    constructorArguments: [corePool, resilientOracle, sentinelOracle.address],
  });
};

export default func;
func.tags = ["sentinel"];
