import { ethers } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

/**
 * bStocks are only listed in the BNB Chain Core pool. bsctestnet is left out: its bStocks are mock tokens
 * without a pauseManager() pointer, so none of them could be monitored.
 */
const SUPPORTED_NETWORKS = ["bscmainnet"];

/** Verify a contract on the explorer without failing the deployment (e.g. on a local fork). */
async function verify(address: string | undefined, constructorArguments: unknown[]): Promise<void> {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
  } catch (e) {
    console.log(`verify failed: ${(e as Error).message}`);
  }
}

/**
 * Deploys BStockPauseHandler (Core markets only, wired to the Core EBrake) behind a transparent proxy owned by
 * DefaultProxyAdmin.
 *
 * The VIP grants the handler EBrake's `decreaseCF(address,uint256)`, grants `setMarketMonitored(address,bool)`
 * and registers the monitored markets. This script does neither.
 */
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  // On a local fork, `network.name` is "hardhat"; getNetworkName() returns the forked network
  const networkName = hre.getNetworkName();
  console.log(`Deploying BStockPauseHandler on ${networkName} with the account: ${deployer}`);
  const ADDRESSES = await getConfig(networkName);

  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = ADDRESSES.preconfiguredAddresses.NormalTimelock;

  const eBrake = await getContractAddressOrNullAddress(deployments, "EBrake");
  if (eBrake === ethers.constants.AddressZero) {
    console.log("EBrake not deployed, skipping BStockPauseHandler deployment");
    return;
  }

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const constructorArgs = [eBrake];
  console.log(`BStockPauseHandler constructor args: EBrake ${eBrake}`);
  const result = await deploy("BStockPauseHandler", {
    contract: "BStockPauseHandler",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: constructorArgs,
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

  if (result.newlyDeployed && network.live) {
    console.log(`BStockPauseHandler proxy deployed at: ${result.address}`);
    await verify(result.implementation, constructorArgs);
  }

  const handler = await hre.ethers.getContract("BStockPauseHandler");
  if (network.live && (await handler.owner()) === deployer && (await handler.pendingOwner()) !== timelock) {
    await handler.transferOwnership(timelock);
    console.log(`BStockPauseHandler ownership transferred to timelock: ${timelock}`);
  }
};

export default func;
func.tags = ["bstock-pause-handler"];
// No `dependencies = ["ebrake"]`: EBrake is already live and only its address is needed.
// Depending on the "ebrake" tag would re-run 021, which redeploys EBrake if the local bytecode differs.
func.skip = async (hre: HardhatRuntimeEnvironment) => !SUPPORTED_NETWORKS.includes(hre.getNetworkName());
