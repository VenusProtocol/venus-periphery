import { forking } from "../utils";
import { ETHEREUM_CONFIG } from "./configs";
import { ConfiguratorFixture, createDeployFixture, runConfiguratorTests } from "./shared";

const cfg = ETHEREUM_CONFIG;
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
