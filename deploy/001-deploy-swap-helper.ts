<<<<<<< HEAD
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const BACKEND_SIGNER_ADDRESS = "0x58C450312686B17f0A18a1072d091a0891B8b916";

=======
import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

>>>>>>> 364d26d (feat: deploy scripts)
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

<<<<<<< HEAD
  console.log(
    `Deploying SwapHelper on ${network.name} network with WBNB address: ${nativeTokenWrapper} and backend signer: ${BACKEND_SIGNER_ADDRESS}`,
  );

  await deploy("SwapHelper", {
    from: deployer,
    args: [BACKEND_SIGNER_ADDRESS],
=======
  const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

  await deploy("SwapHelper", {
    from: deployer,
    args: [WBNB_ADDRESS],
>>>>>>> 364d26d (feat: deploy scripts)
    log: true,
    skipIfAlreadyDeployed: true,
  });
};

func.tags = ["SwapHelper"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
