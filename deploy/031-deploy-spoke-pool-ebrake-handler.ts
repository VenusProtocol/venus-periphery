import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

// Deploys the SpokePoolEBrakeHandler on networks with a Spoke PoolRegistry. Run it before the EBrake
// implementation (021), which takes this handler as SPOKE_HANDLER. Governance grants its ACM permissions
// and upgrades EBrake in a VIP.
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  // getNetworkName() resolves HARDHAT_FORK_NETWORK, so a fork dry run picks up the forked network's config
  const networkName = hre.getNetworkName();
  const { AccessControlManager: accessControlManager, SpokePoolRegistry: spokePoolRegistry } = (
    await getConfig(networkName)
  ).preconfiguredAddresses;
  if (!spokePoolRegistry) {
    console.log(`No Spoke PoolRegistry configured for ${networkName}, skipping SpokePoolEBrakeHandler deployment`);
    return;
  }

  const eBrake = (await deployments.get("EBrake")).address;
  const { deployer } = await getNamedAccounts();
  const normalTimelock = await getContractAddressOrNullAddress(deployments, "NormalTimelock");

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  const args = [eBrake, spokePoolRegistry];
  const result = await deployments.deploy("SpokePoolEBrakeHandler", {
    contract: "SpokePoolEBrakeHandler",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args,
    proxy: {
      owner: network.live ? normalTimelock : deployer,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        init: {
          methodName: "initialize",
          args: [accessControlManager],
        },
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  if (result.newlyDeployed && network.live && network.name !== "hardhat") {
    await hre.run("verify:verify", { address: result.implementation, constructorArguments: args });
  }

  const handler = await hre.ethers.getContract("SpokePoolEBrakeHandler");
  if (network.live && (await handler.owner()) === deployer && (await handler.pendingOwner()) !== normalTimelock) {
    await (await handler.transferOwnership(normalTimelock)).wait();
    console.log(`SpokePoolEBrakeHandler ownership transfer started, ${normalTimelock} must call acceptOwnership()`);
  }
};

export default func;
func.tags = ["spoke-pool-ebrake-handler"];
