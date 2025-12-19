import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const BACKEND_SIGNER_ADDRESS = "0x58C450312686B17f0A18a1072d091a0891B8b916";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const timelock = await deployments.get("NormalTimelock");

  console.log(`Deploying SwapHelper on ${network.name} network with Backend Signer Address: ${BACKEND_SIGNER_ADDRESS}`);

  await deploy("SwapHelper", {
    from: deployer,
    args: [BACKEND_SIGNER_ADDRESS],
    log: true,
    skipIfAlreadyDeployed: true,
  });

  const swapHelper = await ethers.getContract("SwapHelper");
  const owner = await swapHelper.owner();

  console.log(`swapHelper verify arguments: ${swapHelper.address} ${BACKEND_SIGNER_ADDRESS}`);

  if (owner === deployer) {
    console.log("Transferring ownership to Normal Timelock ....");
    const tx = await swapHelper.transferOwnership(timelock.address);
    await tx.wait();
    console.log("Ownership transferred to Normal Timelock");
  }
};

func.tags = ["SwapHelper"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
