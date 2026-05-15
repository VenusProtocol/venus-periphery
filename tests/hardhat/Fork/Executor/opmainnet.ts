import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { forking } from "../utils";
import { opmainnetConfig } from "./configs";
import { ExecutorFixture, createDeployFixture, runIsolatedPoolTests } from "./shared";

const FORK = process.env.FORKED_NETWORK === "opmainnet";
const config = opmainnetConfig;

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
