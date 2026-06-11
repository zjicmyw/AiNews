import assert from "node:assert/strict";
import test from "node:test";
import { RiskEngine } from "../src/riskEngine.js";

test("RiskEngine uses Level2 threshold 60 as the boundary", () => {
  const engine = new RiskEngine(
    {
      level2Threshold: 60,
      level3Threshold: 75,
      marketConfirmStrong: 70
    },
    {}
  );

  assert.equal(engine.computeLevel(59, 0, false), 1);
  assert.equal(engine.computeLevel(60, 0, false), 2);
});
