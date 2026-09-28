import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  approveApproval,
  editApproval,
  handleProposal,
  rejectApproval,
} from "../approvalService.js";
import {
  loadApprovals,
  loadExecutions,
  upsertApproval,
} from "../approvalStore.js";
import { loadAudit } from "../auditLog.js";
import { resolveExpectedHash } from "../cli.js";
import type { DataPaths } from "../config.js";
import { executeAction } from "../executor.js";
import { evaluatePolicy } from "../policy.js";
import { ActionProposalSchema, type ApprovalRecord } from "../types.js";
import { hashAction } from "../utils.js";

// These tests exercise the workflow with NO model calls and NO OpenAI key.
// Every test gets its own temporary data directory so the committed demo files
// under ./data are never touched.

function tempPaths(): DataPaths {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-test-"));
  return {
    approvals: path.join(dir, "approvals.json"),
    audit: path.join(dir, "audit-log.json"),
    executions: path.join(dir, "executions.json"),
  };
}

const REFUND_REQUEST = "Refund €79.00 for order ORD-001 because the package arrived damaged.";

function refundProposal(amount = 79) {
  return {
    toolName: "refundOrder",
    arguments: {
      orderId: "ORD-001",
      amount,
      currency: "EUR",
      reason: "Package arrived damaged",
    },
    reason: "Customer reports the package arrived damaged.",
  };
}

// ── tiny test runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log("\nHuman-in-the-Loop — tests\n");

// 1–4: deterministic policy decisions.
test("getOrderStatus receives auto_execute", () => {
  assert.equal(evaluatePolicy("getOrderStatus").decision, "auto_execute");
});
test("refundOrder receives require_approval", () => {
  assert.equal(evaluatePolicy("refundOrder").decision, "require_approval");
});
test("cancelSubscription receives require_approval", () => {
  assert.equal(evaluatePolicy("cancelSubscription").decision, "require_approval");
});
test("deleteProductionUsers receives deny", () => {
  assert.equal(evaluatePolicy("deleteProductionUsers").decision, "deny");
});

// 5: a refund proposal creates a pending approval and does not execute.
test("refund proposal creates a pending approval and does not execute", () => {
  const paths = tempPaths();
  const outcome = handleProposal(paths, REFUND_REQUEST, refundProposal());
  assert.equal(outcome.kind, "pending");
  const approvals = loadApprovals(paths);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].revision, 1);
  assert.equal(loadExecutions(paths).length, 0);
});

// 6: approving a valid pending refund executes it once.
test("approving a valid pending refund executes it once", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const result = approveApproval(paths, record.id, record.argsHash);
  assert.equal(result.blocked, false);
  assert.equal(result.record.status, "executed");
  const executions = loadExecutions(paths);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].result.status, "processed");
});

// 7: approving the same record again does not execute it twice.
test("approving the same record again does not execute twice", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  approveApproval(paths, record.id, record.argsHash);
  const second = approveApproval(paths, record.id, record.argsHash);
  assert.equal(second.blocked, true);
  assert.equal(loadExecutions(paths).length, 1);
  assert.equal(loadApprovals(paths)[0].status, "executed");
});

// 8: rejecting a pending action prevents execution.
test("rejecting a pending action prevents execution", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const rejected = rejectApproval(paths, record.id, "Customer is not eligible");
  assert.equal(rejected.status, "rejected");
  assert.equal(loadExecutions(paths).length, 0);
  assert.throws(() => approveApproval(paths, record.id, record.argsHash), /not "pending"/);
});

// 9: editing a pending refund to €49 succeeds.
test("editing a pending refund to €49 succeeds", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const { after } = editApproval(
    paths,
    record.id,
    { amount: "49", reason: "Partial refund approved after review" },
    record.argsHash
  );
  assert.equal(after.amount, 49);
  assert.equal(loadApprovals(paths)[0].status, "pending");
  assert.equal(loadApprovals(paths)[0].proposedAction.arguments.amount, 49);
  assert.equal(loadApprovals(paths)[0].revision, 2);
});

// 10: editing a refund to a negative amount fails validation.
test("editing a refund to a negative amount fails validation", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.throws(() => editApproval(paths, record.id, { amount: "-10" }, record.argsHash));
  // The record is unchanged and still valid.
  assert.equal(loadApprovals(paths)[0].proposedAction.arguments.amount, 79);
  assert.equal(loadApprovals(paths)[0].revision, 1);
});

// 11: editing protected approval fields is not allowed.
test("editing protected approval fields is not allowed", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.throws(
    () => editApproval(paths, record.id, { status: "executed" }, record.argsHash),
    /protected field/
  );
  assert.throws(
    () => editApproval(paths, record.id, { id: "APR-999" }, record.argsHash),
    /protected field/
  );
  assert.throws(
    () => editApproval(paths, record.id, { argsHash: "deadbeef" }, record.argsHash),
    /protected field/
  );
});

// 12: a denied action never reaches a tool executor.
test("a denied action never reaches a tool executor", () => {
  const paths = tempPaths();
  const outcome = handleProposal(paths, "Delete all production users.", {
    toolName: "deleteProductionUsers",
    arguments: {},
    reason: "User asked to delete all production users.",
  });
  assert.equal(outcome.kind, "denied");
  assert.equal(loadApprovals(paths).length, 0);
  assert.equal(loadExecutions(paths).length, 0);

  // Defense in depth: even a direct executor call is refused, for a record
  // that is actually in the store (the executor now reloads by ID and cannot
  // be handed an in-memory object at all).
  const now = new Date().toISOString();
  const forgedRecord: ApprovalRecord = {
    id: "APR-999",
    originalRequest: "forged",
    proposedAction: {
      toolName: "deleteProductionUsers",
      arguments: {},
      reason: "forged",
    },
    status: "pending",
    revision: 1,
    argsHash: hashAction("deleteProductionUsers", {}),
    createdAt: now,
    updatedAt: now,
  };
  upsertApproval(paths, forgedRecord);
  assert.throws(() => executeAction(paths, forgedRecord.id), /denied by policy/);
});

// 13: approval data survives store reloading.
test("approval data survives store reloading", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // Fresh read from disk (no in-memory state carried over).
  const reloaded = loadApprovals(paths).find((r) => r.id === record.id);
  assert.ok(reloaded);
  assert.equal(reloaded?.originalRequest, REFUND_REQUEST);
  assert.equal(reloaded?.proposedAction.arguments.amount, 79);
});

// 14: expected audit events are written in the correct lifecycle.
test("expected audit events are written in the correct lifecycle", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const { record: edited } = editApproval(paths, record.id, { amount: "49" }, record.argsHash);
  approveApproval(paths, record.id, edited.argsHash);
  approveApproval(paths, record.id, edited.argsHash); // duplicate → blocked

  const events = loadAudit(paths).map((e) => e.event);
  assert.deepEqual(events, [
    "ACTION_PROPOSED",
    "POLICY_EVALUATED",
    "APPROVAL_REQUESTED",
    "ACTION_EDITED",
    "ACTION_APPROVED",
    "ACTION_EXECUTED",
    "DUPLICATE_EXECUTION_BLOCKED",
  ]);
});

// 15: malformed persisted JSON produces a clear error, not a silent reset.
test("malformed persisted JSON produces a clear error", () => {
  const paths = tempPaths();
  writeFileSync(paths.approvals, "{ this is not valid json", "utf8");
  assert.throws(() => loadApprovals(paths), /malformed JSON/);
});

// ── control-boundary tests ───────────────────────────────────────────────────

// 16: a pending refund cannot bypass human approval through the executor.
test("pending refund cannot bypass human approval through the executor", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.equal(record.status, "pending");
  assert.throws(() => executeAction(paths, record.id), /human approval|required.*approved/i);
  assert.equal(loadExecutions(paths).length, 0);
});

// 17: a rejected refund cannot execute directly through the executor.
test("rejected refund cannot execute directly through the executor", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const rejected = rejectApproval(paths, record.id, "Customer is not eligible");
  assert.equal(rejected.status, "rejected");
  assert.throws(() => executeAction(paths, rejected.id), /human approval|approved/i);
  assert.equal(loadExecutions(paths).length, 0);
});

// 18: the executor accepts an approved record (the other side of boundary 2).
test("executor accepts an approved refund record", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const approved: ApprovalRecord = {
    ...record,
    status: "approved",
    approvedArgsHash: record.argsHash,
    approvedAt: new Date().toISOString(),
  };
  upsertApproval(paths, approved);
  const outcome = executeAction(paths, approved.id);
  assert.equal(outcome.recovered, false);
  assert.equal(outcome.result.status, "processed");
  assert.equal(loadExecutions(paths).length, 1);
  assert.equal(loadExecutions(paths)[0].argsHash, record.argsHash);
});

// 19: a model-supplied permission field is rejected by the proposal schema.
test("proposal rejects model-supplied permission fields", () => {
  assert.throws(() =>
    ActionProposalSchema.parse({ ...refundProposal(), requiresApproval: false })
  );
  assert.throws(() =>
    ActionProposalSchema.parse({ ...refundProposal(), isAuthorized: true })
  );
});

// 20: an existing execution is reused rather than duplicated (crash recovery).
test("an existing execution is reused rather than duplicated", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // Simulate a crash: the record is approved and the tool ran (an execution is
  // saved), but the status was never flipped to "executed".
  const approved: ApprovalRecord = {
    ...record,
    status: "approved",
    approvedArgsHash: record.argsHash,
    approvedAt: new Date().toISOString(),
  };
  upsertApproval(paths, approved);
  const firstRun = executeAction(paths, approved.id);
  assert.equal(firstRun.recovered, false);

  // Retrying approval must NOT call the tool again.
  const retry = approveApproval(paths, record.id, record.argsHash);
  assert.equal(retry.blocked, false);
  assert.equal(retry.execution?.recovered, true);
  assert.equal(retry.execution?.executionId, firstRun.executionId);
  assert.equal(retry.record.status, "executed");
  assert.equal(loadExecutions(paths).length, 1);
});

// 21: a failed auto-execution is not left marked executed.
test("failed auto-execution is not left marked executed", () => {
  const paths = tempPaths();
  // getOrderStatus auto-executes, but ORD-999 does not exist, so the tool throws.
  assert.throws(
    () =>
      handleProposal(paths, "Check the status of order ORD-999.", {
        toolName: "getOrderStatus",
        arguments: { orderId: "ORD-999" },
        reason: "Look up the order status.",
      }),
    /Unknown order/
  );
  // A record may exist as "approved", but never as "executed", and no execution
  // record was written.
  assert.ok(loadApprovals(paths).every((r) => r.status !== "executed"));
  assert.equal(loadExecutions(paths).length, 0);
});

// 22: a policy that no longer says require_approval blocks the approval path.
test("policy mismatch blocks approval", () => {
  const paths = tempPaths();
  // A stored pending approval whose tool is classified auto_execute, not
  // require_approval — a stale workflow the current policy no longer matches.
  const now = new Date().toISOString();
  const args = { orderId: "ORD-001" };
  const stale: ApprovalRecord = {
    id: "APR-001",
    originalRequest: "Check the status of order ORD-001.",
    proposedAction: {
      toolName: "getOrderStatus",
      arguments: args,
      reason: "Look up the order status.",
    },
    status: "pending",
    revision: 1,
    argsHash: hashAction("getOrderStatus", args),
    createdAt: now,
    updatedAt: now,
  };
  upsertApproval(paths, stale);
  assert.throws(
    () => approveApproval(paths, "APR-001", stale.argsHash),
    /no longer classified as require_approval/
  );
  assert.equal(loadExecutions(paths).length, 0);
});

// 23: a denied action writes ACTION_DENIED and creates no records.
test("denied action writes ACTION_DENIED and creates no records", () => {
  const paths = tempPaths();
  handleProposal(paths, "Delete all production users.", {
    toolName: "deleteProductionUsers",
    arguments: {},
    reason: "User asked to delete all production users.",
  });
  const events = loadAudit(paths).map((e) => e.event);
  assert.deepEqual(events, ["ACTION_PROPOSED", "POLICY_EVALUATED", "ACTION_DENIED"]);
  assert.equal(loadApprovals(paths).length, 0);
  assert.equal(loadExecutions(paths).length, 0);
});

// ── content-binding tests (approval binds to content, not the record) ───────

// 24: canonical hash is key-order independent.
test("canonical hash is key-order independent", () => {
  const h1 = hashAction("refundOrder", {
    orderId: "ORD-001",
    amount: 49,
    currency: "EUR",
    reason: "x",
  });
  const h2 = hashAction("refundOrder", {
    reason: "x",
    currency: "EUR",
    amount: 49,
    orderId: "ORD-001",
  });
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

// 25: approving with the correct post-edit hash executes the edited amount.
test("approve with the correct hash after an edit executes the edited amount", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const { record: edited } = editApproval(paths, record.id, { amount: "49" }, record.argsHash);
  const outcome = approveApproval(paths, record.id, edited.argsHash);
  assert.equal(outcome.record.status, "executed");
  const execution = loadExecutions(paths)[0];
  assert.equal(execution.result.amount, 49);
  assert.equal(execution.argsHash, outcome.record.approvedArgsHash);
});

// 26: stale-view race — the €49/€79 two-reviewer scenario.
test("stale-view race: approving with the pre-edit hash is refused, nothing executes", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const staleHash = record.argsHash; // what reviewer A is looking at (€79)
  editApproval(paths, record.id, { amount: "49" }, staleHash); // reviewer B edits to €49

  assert.throws(
    () => approveApproval(paths, record.id, staleHash), // reviewer A approves the €79 they saw
    /changed since you reviewed it/
  );

  const current = loadApprovals(paths)[0];
  assert.equal(current.status, "pending");
  assert.equal(loadExecutions(paths).length, 0);
  const events = loadAudit(paths).map((e) => e.event);
  assert.ok(events.includes("APPROVAL_BINDING_MISMATCH"));
});

// 27: editing with a stale expected hash is refused and leaves arguments unchanged.
test("editing with a stale expected hash is refused", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  editApproval(paths, record.id, { amount: "49" }, record.argsHash); // revision 2 now
  assert.throws(
    () => editApproval(paths, record.id, { amount: "10" }, record.argsHash), // stale (revision-1) hash
    /changed since you reviewed it/
  );
  assert.equal(loadApprovals(paths)[0].proposedAction.arguments.amount, 49);
  assert.equal(loadApprovals(paths)[0].revision, 2);
});

// 28: tampered store — arguments changed after approval, before execution runs.
test("tampered store: executor refuses when stored arguments no longer match the approved hash", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const approved: ApprovalRecord = {
    ...record,
    status: "approved",
    approvedArgsHash: record.argsHash, // bound to the €79 payload
    approvedAt: new Date().toISOString(),
  };
  upsertApproval(paths, approved);

  // Tamper with the stored arguments directly, before executeAction ever runs.
  const tampered: ApprovalRecord = {
    ...approved,
    proposedAction: {
      ...approved.proposedAction,
      arguments: { ...approved.proposedAction.arguments, amount: 999 },
    },
  };
  upsertApproval(paths, tampered);

  assert.throws(() => executeAction(paths, tampered.id), /do not match the approved payload/);
  assert.equal(loadExecutions(paths).length, 0, "runTool must never have been called");
  assert.notEqual(loadApprovals(paths)[0].status, "executed");
  const events = loadAudit(paths).map((e) => e.event);
  assert.ok(events.includes("EXECUTION_BINDING_MISMATCH"));
});

// 29: forged record — approved with no approvedArgsHash at all.
test("forged record with status approved but no approvedArgsHash is refused", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const forged: ApprovalRecord = { ...record, status: "approved" }; // no approvedArgsHash
  upsertApproval(paths, forged);
  assert.throws(() => executeAction(paths, forged.id), /do not match the approved payload/);
  assert.equal(loadExecutions(paths).length, 0);
});

// 30: stored argsHash inconsistent with stored arguments (integrity) → approve refuses.
test("stored argsHash inconsistent with stored arguments is refused at approval", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // argsHash is left as the original (€79) hash while the arguments are
  // changed underneath it directly in the store — an integrity violation.
  const corrupted: ApprovalRecord = {
    ...record,
    proposedAction: {
      ...record.proposedAction,
      arguments: { ...record.proposedAction.arguments, amount: 999 },
    },
  };
  upsertApproval(paths, corrupted);
  assert.throws(() => approveApproval(paths, record.id, record.argsHash), /changed since you reviewed it/);
  assert.equal(loadApprovals(paths)[0].status, "pending");
  assert.equal(loadExecutions(paths).length, 0);
});

// 31: auto_execute sets approvedArgsHash from policy and still executes.
test("auto_execute sets approvedArgsHash from policy and executes", () => {
  const paths = tempPaths();
  const outcome = handleProposal(paths, "Check the status of order ORD-001.", {
    toolName: "getOrderStatus",
    arguments: { orderId: "ORD-001" },
    reason: "Look up the order status.",
  });
  assert.equal(outcome.kind, "auto_executed");
  if (outcome.kind !== "auto_executed") throw new Error("unreachable");
  assert.equal(outcome.record.status, "executed");
  assert.equal(outcome.record.approvedArgsHash, outcome.record.argsHash);
  assert.equal(loadExecutions(paths)[0].argsHash, outcome.record.approvedArgsHash);
});

// 32: the CLI's hash-prefix parsing helper rejects prefixes under 12 characters.
test("CLI rejects an --expect prefix shorter than 12 characters", () => {
  const paths = tempPaths();
  assert.throws(() => resolveExpectedHash(paths, "APR-001", "short"), /at least 12/);
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
