import { forking } from "../utils";
import { ARBITRUMONE_CONFIG } from "./configs";
import { ConfiguratorFixture, createDeployFixture, runConfiguratorTests } from "./shared";

const cfg = ARBITRUMONE_CONFIG;
const deployFixture = createDeployFixture(cfg);

if (process.env.FORKED_NETWORK === cfg.networkName) {
  forking(cfg.forkBlock, () => {
    let fixture: ConfiguratorFixture;
    const get = () => fixture;

    before(async () => {
      fixture = await deployFixture();
    });

    describe(`DeviationSentinelConfigurator Fork Tests (${cfg.label})`, () => {
      runConfiguratorTests(cfg, get, () => false);
    });
  });
}
