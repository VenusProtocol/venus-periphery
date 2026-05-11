import { ethers } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getContractAddressOrNullAddress } from "../helpers/deploymentConfig";
import {
  EBRAKE_FUNCTIONS_FOR_EXECUTOR,
  EXECUTOR_CONFIG,
  EXECUTOR_HANDLER_SIGS,
  EXECUTOR_SET_MARKET_CONFIG_SIG,
} from "../helpers/executorConfig";

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string functionSig, address accountToPermit)",
  "function hasPermission(address account, address contractAddress, string functionSig) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

type Grant = { target: string; sig: string; caller: string };

const dedupeLower = (addrs: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (a === ethers.constants.AddressZero || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
};

const buildGrants = (
  executorAddr: string,
  eBrakeAddr: string,
  signalCallers: string[],
  configAdmins: string[],
): Grant[] => {
  const grants: Grant[] = [];
  for (const sig of EXECUTOR_HANDLER_SIGS) {
    for (const caller of signalCallers) {
      grants.push({ target: executorAddr, sig, caller });
    }
  }
  for (const sig of EBRAKE_FUNCTIONS_FOR_EXECUTOR) {
    grants.push({ target: eBrakeAddr, sig, caller: executorAddr });
  }
  for (const caller of configAdmins) {
    grants.push({ target: executorAddr, sig: EXECUTOR_SET_MARKET_CONFIG_SIG, caller });
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
  const timelockAddr = await getContractAddressOrNullAddress(deployments, "NormalTimelock");

  if (executorAddr === ethers.constants.AddressZero) {
    console.log("Executor not deployed; skipping ACM configuration");
    return;
  }
  if (eBrakeAddr === ethers.constants.AddressZero) {
    console.log("EBrake not deployed; skipping ACM configuration");
    return;
  }

  const configAdmins = dedupeLower([timelockAddr, ...cfg.extraConfigAdmins]);
  const grants = buildGrants(executorAddr, eBrakeAddr, cfg.signalCallers, configAdmins);
  if (grants.length === 0) {
    console.log("No grants to apply for this network");
    return;
  }

  const signer = await hre.ethers.getSigner(deployer);
  const acm = new hre.ethers.Contract(acmAddr, ACM_ABI, signer);

  // OpenZeppelin's DEFAULT_ADMIN_ROLE is bytes32(0). We still call DEFAULT_ADMIN_ROLE()
  // as a basic ACM-sanity probe, but the role value itself is just zero — don't gate
  // hasRole() on it being non-zero.
  let adminRole = ethers.constants.HashZero;
  try {
    adminRole = await acm.DEFAULT_ADMIN_ROLE();
  } catch (e) {
    console.log(`could not read DEFAULT_ADMIN_ROLE: ${(e as Error).message}`);
  }

  if (cfg.expectedAcmAdmin) {
    try {
      const isAdmin = await acm.hasRole(adminRole, cfg.expectedAcmAdmin);
      console.log(
        `Expected ACM admin ${cfg.expectedAcmAdmin}: ${isAdmin ? "HOLDS" : "does NOT hold"} DEFAULT_ADMIN_ROLE`,
      );
      if (!isAdmin) {
        console.log("Warning: configured expectedAcmAdmin does not hold DEFAULT_ADMIN_ROLE on this ACM");
      }
    } catch (e) {
      console.log(`hasRole check failed for expectedAcmAdmin: ${(e as Error).message}`);
    }
  }

  let deployerIsAdmin = false;
  try {
    deployerIsAdmin = await acm.hasRole(adminRole, deployer);
  } catch (e) {
    console.log(`could not check deployer admin role: ${(e as Error).message}`);
  }

  if (!deployerIsAdmin) {
    console.log(`\nDeployer (${deployer}) is NOT ACM admin on ${network.name}.`);
    console.log(
      `Submit the following ${grants.length} calls via the ACM admin (${cfg.expectedAcmAdmin || "timelock / multisig"}):\n`,
    );
    for (const g of grants) {
      console.log(`  AccessControlManager.giveCallPermission("${g.target}", "${g.sig}", "${g.caller}")`);
    }
    return;
  }

  console.log(`\nDeployer is ACM admin. Granting ${grants.length} permissions...`);
  for (const g of grants) {
    let already = false;
    try {
      already = await acm.hasPermission(g.caller, g.target, g.sig);
    } catch {
      already = false;
    }
    if (already) {
      console.log(`  skip (already granted): ${g.target} ${g.sig} -> ${g.caller}`);
      continue;
    }
    const tx = await acm.giveCallPermission(g.target, g.sig, g.caller);
    await tx.wait();
    console.log(`  granted: ${g.target} ${g.sig} -> ${g.caller}`);
  }
};

export default func;
func.tags = ["executor-acm"];
func.dependencies = ["executor"];
