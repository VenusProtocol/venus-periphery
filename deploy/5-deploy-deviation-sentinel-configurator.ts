import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// All addresses inside each child are hardcoded constants — mainnet-only.
const CONFIGURATOR_CONTRACT: Record<string, string> = {
  ethereum: "DeviationSentinelConfiguratorEthereum",
  arbitrumone: "DeviationSentinelConfiguratorArbitrumOne",
  basemainnet: "DeviationSentinelConfiguratorBaseMainnet",
};

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const contractName = CONFIGURATOR_CONTRACT[network.name];
  if (!contractName) {
    console.log(`DeviationSentinelConfigurator: unsupported network ${network.name}, skipping`);
    return;
  }

  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`Deploying ${contractName} with the account: ${deployer}`);

  const result = await deploy("DeviationSentinelConfigurator", {
    contract: contractName,
    from: deployer,
    log: true,
    deterministicDeployment: false,
    args: [],
  });

  if (result.newlyDeployed) {
    console.log(`${contractName} deployed at: ${result.address}`);
    if (network.live) {
      await hre.run("verify:verify", {
        address: result.address,
        constructorArguments: [],
      });
    }
  }
};

export default func;
func.tags = ["deviation-sentinel-configurator"];
