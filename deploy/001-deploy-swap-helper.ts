import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const BACKEND_SIGNER_ADDRESS = "0x58C450312686B17f0A18a1072d091a0891B8b916";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log(`Deploying SwapHelper on ${network.name} network with backend signer: ${BACKEND_SIGNER_ADDRESS}`);

  await deploy("SwapHelper", {
    from: deployer,
    args: [BACKEND_SIGNER_ADDRESS],
    log: true,
    skipIfAlreadyDeployed: true,
  });
};

func.tags = ["SwapHelper"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
