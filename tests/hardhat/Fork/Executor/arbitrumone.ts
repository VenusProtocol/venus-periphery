import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { forking } from "../utils";
import { arbitrumoneConfig } from "./configs";
import { ExecutorFixture, createDeployFixture, runIsolatedPoolTests } from "./shared";

const FORK = process.env.FORKED_NETWORK === "arbitrumone";
const config = arbitrumoneConfig;

if (FORK) {
  const deployFixture = createDeployFixture(config);

  forking(config.forkBlock, () => {
    let fixture: ExecutorFixture;
    const get = () => fixture;

    describe(`Executor Fork Tests (${config.label})`, () => {
      beforeEach(async () => {
        fixture = await loadFixture(deployFixture);
      });

      runIsolatedPoolTests(config, get);
    });
  });
}
