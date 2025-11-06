import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const WBNB_ADDRESS_BSCMAINNET = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const WrappedNativeAddressOnNetwork = {
  hardhat: WBNB_ADDRESS_BSCMAINNET,
  bscmainnet: WBNB_ADDRESS_BSCMAINNET,
  bsctestnet: WBNB_ADDRESS_BSCMAINNET,
};

const BACKEND_SIGNER_ADDRESS = "0x58C450312686B17f0A18a1072d091a0891B8b916";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  if (!(network.name in WrappedNativeAddressOnNetwork)) {
    throw new Error(`No wrapped native token address configured for network ${network.name}`);
  }

  const nativeTokenWrapper = WrappedNativeAddressOnNetwork[network.name as keyof typeof WrappedNativeAddressOnNetwork];

  console.log(
    `Deploying SwapHelper on ${network.name} network with WBNB address: ${nativeTokenWrapper} and backend signer: ${BACKEND_SIGNER_ADDRESS}`,
  );

  await deploy("SwapHelper", {
    from: deployer,
    args: [nativeTokenWrapper, BACKEND_SIGNER_ADDRESS],
    log: true,
    skipIfAlreadyDeployed: true,
  });
};

func.tags = ["SwapHelper"];
func.skip = async hre => hre.network.name === "hardhat";

export default func;
