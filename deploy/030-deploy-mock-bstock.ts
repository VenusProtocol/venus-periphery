import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Deploys MockBStockToken on bsctestnet so BStockPauseSentinel has a pausable bStock to monitor.
 * The deployer keeps ownership so it can pause and unpause the token from the keeper side.
 */
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying MockBStockToken with the account: ${deployer}`);

  const constructorArgs = ["Mock Tesla bStock", "TSLAB"];
  const result = await deploy("MockBStockToken", {
    contract: "MockBStockToken",
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: constructorArgs,
  });

  if (result.newlyDeployed && network.live) {
    await hre.run("verify:verify", { address: result.address, constructorArguments: constructorArgs });
  }
};

export default func;
func.tags = ["mock-bstock"];
func.skip = async (hre: HardhatRuntimeEnvironment) => hre.getNetworkName() !== "bsctestnet";
