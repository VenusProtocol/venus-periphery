import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig } from "../helpers/deploymentConfig";

/** The Liquidity Hub, which holds the waiting stables, only runs on BNB Chain. */
const SUPPORTED_NETWORKS = ["bscmainnet", "bsctestnet"];

/** Verify a contract on the explorer without failing the deployment (e.g. on a local fork). */
async function verify(address: string | undefined, constructorArguments: unknown[]): Promise<void> {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
  } catch (e) {
    console.log(`verify failed: ${(e as Error).message}`);
  }
}

/**
 * Deploys SmartDCA behind a transparent proxy owned by DefaultProxyAdmin, with the Venus Treasury as the
 * reserve, and the read only SmartDCALens.
 *
 * The VIP accepts ownership, grants the ACM permissions, and sets the keepers and the pairs with their
 * yield sources. This script does none of that.
 */
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  // On a local fork, `network.name` is "hardhat"; getNetworkName() returns the forked network
  const networkName = hre.getNetworkName();
  console.log(`Deploying SmartDCA on ${networkName} with the account: ${deployer}`);
  const ADDRESSES = await getConfig(networkName);

  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = ADDRESSES.preconfiguredAddresses.NormalTimelock;
  const resilientOracle = ADDRESSES.preconfiguredAddresses.ResilientOracle;
  const hubRegistry = ADDRESSES.preconfiguredAddresses.HubRegistry;
  const comptroller = (await deployments.get("Unitroller")).address;
  const swapHelper = (await deployments.get("SwapHelper")).address;
  const reserve = (await deployments.get("VTreasury")).address;

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const constructorArgs = [comptroller, hubRegistry, resilientOracle, swapHelper];
  console.log(
    `SmartDCA constructor args: Comptroller ${comptroller}, HubRegistry ${hubRegistry}, ResilientOracle ${resilientOracle}, SwapHelper ${swapHelper}`,
  );
  console.log(`SmartDCA initialize args: AccessControlManager ${accessControlManager}, reserve ${reserve}`);
  const result = await deploy("SmartDCA", {
    contract: "SmartDCA",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: constructorArgs,
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager, reserve],
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  if (result.newlyDeployed && network.live) {
    console.log(`SmartDCA proxy deployed at: ${result.address}`);
    await verify(result.implementation, constructorArgs);
  }

  const smartDCA = await hre.ethers.getContract("SmartDCA");
  if (network.live && (await smartDCA.owner()) === deployer && (await smartDCA.pendingOwner()) !== timelock) {
    await smartDCA.transferOwnership(timelock);
    console.log(`SmartDCA ownership transferred to timelock: ${timelock}`);
  }

  const lens = await deploy("SmartDCALens", {
    contract: "SmartDCALens",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [],
  });

  if (lens.newlyDeployed && network.live) {
    await verify(lens.address, []);
  }
};

export default func;
func.tags = ["smart-dca"];
func.skip = async (hre: HardhatRuntimeEnvironment) => !SUPPORTED_NETWORKS.includes(hre.getNetworkName());
