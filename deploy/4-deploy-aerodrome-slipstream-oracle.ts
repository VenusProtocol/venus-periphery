import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig } from "../helpers/deploymentConfig";

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying AerodromeSlipstreamOracle with the account: ${deployer}`);
  const ADDRESSES = await getConfig(network.name);

  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = ADDRESSES.preconfiguredAddresses.NormalTimelock;
  const resilientOracle = ADDRESSES.preconfiguredAddresses.ResilientOracle;

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const existingProxy = await deployments.getOrNull("AerodromeSlipstreamOracle");

  const result = await deploy("AerodromeSlipstreamOracle", {
    contract: "AerodromeSlipstreamOracle",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [resilientOracle],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      ...(existingProxy === null && {
        execute: {
          methodName: "initialize",
          args: [accessControlManager],
        },
      }),
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  if (result.newlyDeployed && network.live) {
    console.log(`AerodromeSlipstreamOracle proxy deployed at: ${result.address}`);
    await hre.run("verify:verify", {
      address: result.implementation,
      constructorArguments: [resilientOracle],
    });
  }

  const oracle = await hre.ethers.getContract("AerodromeSlipstreamOracle");
  if (network.live && (await oracle.owner()) === deployer && (await oracle.pendingOwner()) !== timelock) {
    await oracle.transferOwnership(timelock);
    console.log(`AerodromeSlipstreamOracle ownership transferred to timelock: ${timelock}`);
  }
};

export default func;
func.tags = ["aerodrome-slipstream-oracle"];
