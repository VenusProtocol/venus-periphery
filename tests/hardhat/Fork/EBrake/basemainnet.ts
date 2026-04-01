import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { forking } from "../utils";
import { basemainnetConfig } from "./configs";
import { EBrakeFixture, createDeployFixture, runSharedTests } from "./shared";

const config = basemainnetConfig;

if (process.env.FORKED_NETWORK === config.networkName) {
  const deployFixture = createDeployFixture(config);

  forking(config.forkBlock, () => {
    let fixture: EBrakeFixture;
    const get = () => fixture;

    describe(`EBrake Fork Tests (${config.label} — IL Core Pool)`, () => {
      beforeEach(async () => {
        fixture = await loadFixture(deployFixture);
      });

      runSharedTests(config, get);
    });
  });
}
