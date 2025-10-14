import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { preconfiguredAddresses } from "../helpers/deploymentConfig";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const proxyOwnerAddress = preconfiguredAddresses[network.name].NormalTimelock;

  await deploy("Undertaker", {
    from: deployer,
    args: [],
    log: true,
    skipIfAlreadyDeployed: true,
  });

  const undertaker = await hre.ethers.getContract("Undertaker");
  const owner = await undertaker.owner();

  if (owner === deployer) {
    await undertaker.transferOwnership(proxyOwnerAddress);
    console.log(`Ownership of Undertaker transferred from deployer to Timelock (${proxyOwnerAddress})`);
  }
};

func.tags = ["undertaker"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
