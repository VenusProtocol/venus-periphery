import fs from "fs";
import hre from "hardhat";
import path from "path";

/**
 * Verifies deployed contracts by reading addresses and constructor args from deployment artifacts.
 *
 * Usage:
 *   npx hardhat run scripts/verify-deployments.ts --network bsctestnet
 */

// Skip contracts deployed before enabling viaIR compiler setting
const CONTRACTS_TO_SKIP = ["DefaultProxyAdmin", "LeverageStrategiesManager_Proxy", "RelativePositionManager_Proxy"];

async function main() {
  const deploymentsDir = path.join(__dirname, "..", "deployments", hre.network.name);

  const allFiles = fs.readdirSync(deploymentsDir).filter(f => f.endsWith(".json") && f !== ".chainId");
  const contractNames = allFiles.map(f => f.replace(".json", "")).filter(name => !CONTRACTS_TO_SKIP.includes(name));

  for (const name of contractNames) {
    const filePath = path.join(deploymentsDir, `${name}.json`);

    const { address, args } = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    console.log(`Verifying ${name} at ${address}`);

    try {
      await hre.run("verify:verify", { address, constructorArguments: args || [] });
      console.log(`${name} verified`);
    } catch (error: any) {
      const msg = error.message || "";
      if (msg.includes("already verified") || msg.includes("Already Verified")) {
        console.log(`${name} already verified`);
      } else {
        console.error(`${name} failed: ${msg}`);
      }
    }
  }
}

main().catch(console.error);
