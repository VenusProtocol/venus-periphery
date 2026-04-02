import { ethers } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying EBrake with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const comptroller = await getContractAddressOrNullAddress(deployments, "Unitroller");
  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = await getContractAddressOrNullAddress(deployments, "NormalTimelock");

  if (comptroller === ethers.constants.AddressZero) {
    console.log("Unitroller not deployed, skipping EBrake deployment");
    return;
  }

  // BSC (bsctestnet, bscmainnet) uses Diamond comptroller → isIsolatedPool = false
  // All other chains use IL comptroller → isIsolatedPool = true
  const isIsolatedPool = !network.name.startsWith("bsc") && network.name !== "hardhat";

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const result = await deploy("EBrake", {
    contract: "EBrake",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [comptroller, isIsolatedPool],
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
    console.log(`EBrake proxy deployed at: ${result.address}`);
    console.log("Verifying EBrake implementation on explorer...");
    await hre.run("verify:verify", {
      address: result.implementation,
      constructorArguments: [comptroller, isIsolatedPool],
    });
  }
};

export default func;
func.tags = ["ebrake"];
