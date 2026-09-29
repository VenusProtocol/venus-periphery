import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getContractAddressOrNullAddress } from "../helpers/deploymentConfig";

// BSC Mainnet addresses
const PENDLE_ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";
const COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const acmAddress = (await deployments.get("AccessControlManager")).address;

  const proxyAdminOwner = await getContractAddressOrNullAddress(deployments, "NormalTimelock");

  const defaultProxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );

  await deploy("PendlePTVaultAdapter", {
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [PENDLE_ROUTER, COMPTROLLER],
    proxy: {
      owner: proxyAdminOwner,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: {
        methodName: "initialize",
        args: [acmAddress],
      },
      viaAdminContract: {
        name: "DefaultProxyAdmin",
        artifact: defaultProxyAdmin,
      },
    },
  });

  // transfer ownership to timelock
  {
    const timelockAddress = await getContractAddressOrNullAddress(deployments, "NormalTimelock");
    const adapter = await ethers.getContract("PendlePTVaultAdapter");
    const currentOwner = (await adapter.owner()).toLowerCase();
    const pendingOwner = (await adapter.pendingOwner()).toLowerCase();

    if (currentOwner !== timelockAddress && pendingOwner === ethers.constants.AddressZero) {
      const tx = await adapter.transferOwnership(timelockAddress);
      await tx.wait();
      console.log(`Ownership transfer initiated to NormalTimelock (${timelockAddress})`);
    } else {
      console.log(`Ownership transfer already pending to ${pendingOwner}`);
    }
  }
};

func.tags = ["PendlePTVaultAdapter"];

func.skip = async (hre: HardhatRuntimeEnvironment) => {
  return hre.network.name !== "bscmainnet" && hre.network.name !== "bsctestnet";
};

export default func;
