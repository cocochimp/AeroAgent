import test from "node:test";
import assert from "node:assert/strict";
import { confirmationRecoveryAction, shouldFollowConfirmation } from "./web/pages/chat.js";

test("only newly accepted or processing confirmations need a new event follower", () => {
  assert.equal(shouldFollowConfirmation("ACCEPTED"), true);
  assert.equal(shouldFollowConfirmation("PROCESSING"), true);
  assert.equal(shouldFollowConfirmation("COMPLETED"), false);
  assert.equal(shouldFollowConfirmation("RESULT_UNKNOWN"), false);
});

test("network-error reconciliation follows confirmed work and refreshes completed orders", () => {
  assert.equal(confirmationRecoveryAction({ status: "PROCESSING", quotes: [{ status: "CONFIRMED" }] }), "follow");
  assert.equal(confirmationRecoveryAction({ status: "WAITING_CONFIRMATION", quotes: [{ status: "CONFIRMED" }] }), "follow");
  assert.equal(confirmationRecoveryAction({ status: "COMPLETED", quotes: [{ status: "EXECUTED" }] }), "refresh");
  assert.equal(confirmationRecoveryAction({ status: "WAITING_CONFIRMATION", quotes: [{ status: "OFFERED" }] }), "snapshot");
  assert.equal(confirmationRecoveryAction({ status: "RESULT_UNKNOWN", quotes: [] }), "snapshot");
});
