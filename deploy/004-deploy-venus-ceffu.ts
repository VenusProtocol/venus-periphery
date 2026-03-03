import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig } from "../helpers/deploymentConfig";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const ADDRESSES = await getConfig(network.name);
  const accessControlManager = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const timelock = ADDRESSES.preconfiguredAddresses.NormalTimelock;

  console.log(`Deploying Venus Ceffu contracts on ${network.name} with deployer: ${deployer}`);

  // Explicitly mentioning Default Proxy Admin contract path to fetch it from hardhat-deploy instead of OpenZeppelin
  // as zksync doesnot compile OpenZeppelin contracts using zksolc. It is backward compatible for all networks as well.
  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  // ─────────────────────────────────────────────────────────────────────
  //  Step 1: Deploy FixedRateVault implementation (non-upgradeable)
  //
  //  This is the logic contract used by VaultFactory for EIP-1167 clones.
  //  Constructor calls `_disableInitializers()` — it is never used directly.
  //  Each vault clone gets its own initialize() call from VaultFactory.deployVault().
  // ─────────────────────────────────────────────────────────────────────

  await deploy("FixedRateVault", {
    from: deployer,
    args: [],
    log: true,
    skipIfAlreadyDeployed: true,
  });

  const vaultImpl = await ethers.getContract("FixedRateVault");
  console.log(`FixedRateVault implementation deployed at: ${vaultImpl.address}`);

  // ─────────────────────────────────────────────────────────────────────
  //  Step 2: Deploy VaultFactory (upgradeable proxy)
  //
  //  Chicken-and-egg: VaultFactory needs FundRouter address, FundRouter needs
  //  VaultFactory address. Solve by deploying VaultFactory first with the deployer
  //  as a placeholder fundRouter, then deploying FundRouter with the real factory
  //  address, and finally updating VaultFactory to point to the real FundRouter.
  //
  //  initialize(accessControlManager, vaultImplementation, fundRouter)
  // ─────────────────────────────────────────────────────────────────────

  await deploy("VaultFactory", {
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager, vaultImpl.address, deployer], // deployer as placeholder fundRouter
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  const vaultFactory = await ethers.getContract("VaultFactory");
  console.log(`VaultFactory proxy deployed at: ${vaultFactory.address}`);

  // ─────────────────────────────────────────────────────────────────────
  //  Step 3: Deploy FundRouter (upgradeable proxy)
  //
  //  initialize(accessControlManager, vaultFactory)
  //  FundRouter is the singleton router managing all fund flows between
  //  FixedRateVaults and Ceffu sub-wallets.
  // ─────────────────────────────────────────────────────────────────────

  await deploy("FundRouter", {
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [],
    proxy: {
      owner: network.live ? timelock : deployer,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [accessControlManager, vaultFactory.address],
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  const fundRouter = await ethers.getContract("FundRouter");
  console.log(`FundRouter proxy deployed at: ${fundRouter.address}`);

  // ─────────────────────────────────────────────────────────────────────
  //  Step 4: Resolve chicken-and-egg — update VaultFactory's fundRouter
  //
  //  Replace the placeholder (deployer) with the real FundRouter address.
  //  On live networks this will need to be done via VIP/timelock since
  //  ownership is transferred below. For initial deployment, deployer
  //  still has ACM permissions at this point.
  // ─────────────────────────────────────────────────────────────────────

  const currentFundRouter = await vaultFactory.fundRouter();
  if (currentFundRouter !== fundRouter.address) {
    console.log("Updating VaultFactory fundRouter to the real FundRouter address...");
    const tx = await vaultFactory.setFundRouter(fundRouter.address);
    await tx.wait();
    console.log(`VaultFactory fundRouter updated to: ${fundRouter.address}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Step 5: Transfer ownership to timelock
  //
  //  After this, all privileged operations (deployVault, setAssetApproval,
  //  sweepToken, pause/unpause, etc.) require governance (VIP) approval.
  // ─────────────────────────────────────────────────────────────────────

  if (network.live) {
    if ((await vaultFactory.owner()) === deployer) {
      console.log("Transferring VaultFactory ownership to timelock...");
      const tx = await vaultFactory.transferOwnership(timelock);
      await tx.wait();
      console.log(`VaultFactory ownership transferred to: ${timelock}`);
    }

    if ((await fundRouter.owner()) === deployer) {
      console.log("Transferring FundRouter ownership to timelock...");
      const tx = await fundRouter.transferOwnership(timelock);
      await tx.wait();
      console.log(`FundRouter ownership transferred to: ${timelock}`);
    }
  }
};

func.tags = ["VenusCeffu"];
func.skip = async (hre: HardhatRuntimeEnvironment) => hre.network.name === "hardhat";

export default func;
