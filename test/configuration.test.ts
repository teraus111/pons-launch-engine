import assert from "node:assert/strict";
import test from "node:test";
import { loadCampaign, validateCampaignStrategies } from "../src/core/campaign.js";
import { readCredentials } from "../src/core/credentials.js";
import { loadStrategies } from "../src/core/strategies.js";

test("published configuration examples validate together", () => {
  const strategies = loadStrategies("strategies.example.json");
  const credentials = readCredentials("credentials.example.json");
  const monitor = loadCampaign("campaign.example.json");
  const launch = loadCampaign("launch-campaign.example.json");

  validateCampaignStrategies(monitor, strategies);
  validateCampaignStrategies(launch, strategies);
  assert.equal(credentials[0]?.name, monitor.wallets[0]?.name);
  assert.equal(credentials[0]?.name, launch.launch?.creatorWallet);
  assert.equal(launch.mode, "launch-and-buy");
});
