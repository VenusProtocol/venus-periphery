import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";
import { EBRAKE_FUNCTIONS_FOR_EXECUTOR, EXECUTOR_CONFIG, EXECUTOR_HANDLER_SIGS } from "../helpers/executorConfig";

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string functionSig, address accountToPermit)",
  "function isAllowedToCall(address account, string functionSig) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

type Grant = { target: string; sig: string; caller: string };

const buildGrants = (executorAddr: string, eBrakeAddr: string, signalCallers: string[]): Grant[] => {
  const grants: Grant[] = [];
  for (const sig of EXECUTOR_HANDLER_SIGS) {
    for (const caller of signalCallers) {
      grants.push({ target: executorAddr, sig, caller });
    }
  }
  for (const sig of EBRAKE_FUNCTIONS_FOR_EXECUTOR) {
    grants.push({ target: eBrakeAddr, sig, caller: executorAddr });
  }
  return grants;
};

const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deployer } = await getNamedAccounts();
  const cfg = EXECUTOR_CONFIG[network.name];
  if (!cfg) {
    console.log(`No Executor config for network ${network.name}; skipping ACM configuration`);
    return;
  }

  const ADDRESSES = await getConfig(network.name);
  const acmAddr = ADDRESSES.preconfiguredAddresses.AccessControlManager;
  const executorAddr = await getContractAddressOrNullAddress(deployments, "Executor");
  const eBrakeAddr = await getContractAddressOrNullAddress(deployments, "EBrake");

  if (executorAddr === "0x0000000000000000000000000000000000000000") {
    console.log("Executor not deployed; skipping ACM configuration");
    return;
  }
  if (eBrakeAddr === "0x0000000000000000000000000000000000000000") {
    console.log("EBrake not deployed; skipping ACM configuration");
    return;
  }

  const grants = buildGrants(executorAddr, eBrakeAddr, cfg.signalCallers);
  if (grants.length === 0) {
    console.log("No grants to apply for this network");
    return;
  }

  const signer = await hre.ethers.getSigner(deployer);
  const acm = new hre.ethers.Contract(acmAddr, ACM_ABI, signer);

  let deployerIsAdmin = false;
  try {
    const adminRole = await acm.DEFAULT_ADMIN_ROLE();
    deployerIsAdmin = await acm.hasRole(adminRole, deployer);
  } catch (e) {
    console.log(`could not check admin role: ${(e as Error).message}`);
  }

  if (!deployerIsAdmin) {
    console.log(`\nDeployer (${deployer}) is NOT ACM admin on ${network.name}.`);
    console.log("Submit the following calls via the ACM admin (timelock / multisig):\n");
    for (const g of grants) {
      console.log(`  AccessControlManager.giveCallPermission("${g.target}", "${g.sig}", "${g.caller}")`);
    }
    return;
  }

  console.log(`\nDeployer is ACM admin. Granting ${grants.length} permissions...`);
  for (const g of grants) {
    let already = false;
    try {
      already = await acm.isAllowedToCall(g.caller, g.sig);
    } catch {
      already = false;
    }
    if (already) {
      console.log(`  skip (already granted): ${g.sig} → ${g.caller}`);
      continue;
    }
    const tx = await acm.giveCallPermission(g.target, g.sig, g.caller);
    await tx.wait();
    console.log(`  granted: ${g.target} ${g.sig} → ${g.caller}`);
  }
};

export default func;
func.tags = ["executor-acm"];
func.dependencies = ["executor"];
