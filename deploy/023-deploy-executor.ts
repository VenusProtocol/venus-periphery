import { ethers } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";
import { EXECUTOR_CONFIG } from "../helpers/executorConfig";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying Executor with the account: ${deployer}`);

  const cfg = EXECUTOR_CONFIG[network.name];
  if (!cfg) {
    console.log(`No Executor config for network ${network.name}; skipping`);
    return;
  }

  const ADDRESSES = await getConfig(network.name);
  const eBrake = await getContractAddressOrNullAddress(deployments, "EBrake");
  const comptroller = await getContractAddressOrNullAddress(deployments, "Unitroller");
  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = await getContractAddressOrNullAddress(deployments, "NormalTimelock");

  if (eBrake === ethers.constants.AddressZero) {
    console.log("EBrake not deployed; skipping Executor deployment");
    return;
  }
  if (comptroller === ethers.constants.AddressZero) {
    console.log("Unitroller not deployed; skipping Executor deployment");
    return;
  }

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const result = await deploy("Executor", {
    contract: "Executor",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [eBrake, comptroller, cfg.isCorePool],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager],
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  if (result.newlyDeployed) {
    console.log(`Executor proxy deployed at: ${result.address}`);
    console.log("Verifying Executor implementation on explorer...");
    try {
      await hre.run("verify:verify", {
        address: result.implementation,
        constructorArguments: [eBrake, comptroller, cfg.isCorePool],
      });
    } catch (e) {
      console.log(`verify failed: ${(e as Error).message}`);
    }
  }

  const executor = await hre.ethers.getContract("Executor");
  if (network.live && (await executor.owner()) === deployer) {
    await executor.transferOwnership(timelock);
    console.log(`Executor ownership transferred to timelock: ${timelock}`);
  }
};

export default func;
func.tags = ["executor"];
