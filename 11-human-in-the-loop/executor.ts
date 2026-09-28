import { appendAudit } from "./auditLog.js";
import {
  findApproval,
  findExecutionByApprovalId,
  nextExecutionId,
  nextResultId,
  saveExecution,
} from "./approvalStore.js";
import type { DataPaths } from "./config.js";
import { evaluatePolicy } from "./policy.js";
import { RESULT_ID_PREFIX, runTool } from "./tools.js";
import { hashAction, nowIso } from "./utils.js";

export interface ExecutionOutcome {
  executionId: string;
  result: Record<string, unknown>;
  // true when an existing execution for this approval was reused instead of
  // running the tool again.
  recovered: boolean;
}

/**
 * Execute the tool behind an approval exactly once (locally) and record it.
 *
 * This is the last gate before a side effect, and it defends the control
 * boundary independently of the approval service — it takes only an ID and
 * always reloads the record from the store itself. It never trusts a record
 * object handed to it by a caller, so a caller cannot forge permission by
 * constructing an object with `status: "approved"` and different arguments.
 *
 *  1. a tool denied by policy never executes;
 *  2. an approval-required tool only executes from an `approved` record — a
 *     pending or rejected record is refused here, not just in the service;
 *  3. if an execution already exists for this approval, the tool is NOT called
 *     again — but the existing execution is only reused if its arguments still
 *     match what was approved;
 *  4. content binding: right before the side effect, the stored arguments are
 *     re-hashed and compared against `approvedArgsHash`. Any mismatch — a
 *     missing hash (a forged or manually-upserted record) or a hash that no
 *     longer matches (the stored arguments were tampered with after approval)
 *     — refuses execution. Nothing runs, nothing is recorded, and the
 *     mismatch is audited.
 *
 * This is local idempotency, not a distributed exactly-once guarantee.
 */
export function executeAction(
  paths: DataPaths,
  approvalId: string
): ExecutionOutcome {
  const approval = findApproval(paths, approvalId);
  if (!approval) {
    throw new Error(`No approval found with id "${approvalId}".`);
  }

  const { toolName, arguments: args } = approval.proposedAction;
  const policy = evaluatePolicy(toolName);

  // Boundary 1: forbidden tools never execute.
  if (policy.decision === "deny") {
    throw new Error(
      `Refusing to execute "${toolName}": denied by policy. ${policy.reason}`
    );
  }

  // Boundary 2: approval-required tools must come from an approved record.
  // A pending or rejected record can never reach a tool through the executor.
  if (policy.decision === "require_approval" && approval.status !== "approved") {
    throw new Error(
      `Refusing to execute "${toolName}": human approval is required and the record is "${approval.status}", not "approved".`
    );
  }

  // Boundary 3 (local idempotency): reuse an existing execution for this
  // approval — but only if its recorded payload still matches what was
  // approved. An execution that no longer matches is never silently replayed.
  const existing = findExecutionByApprovalId(paths, approval.id);
  if (existing) {
    if (!approval.approvedArgsHash || existing.argsHash !== approval.approvedArgsHash) {
      appendAudit(paths, {
        event: "EXECUTION_BINDING_MISMATCH",
        approvalId: approval.id,
        toolName,
        metadata: {
          expected: approval.approvedArgsHash,
          actual: existing.argsHash,
          stage: "reuse",
        },
      });
      throw new Error(
        `Refusing to reuse execution ${existing.id} for ${approval.id}: its recorded arguments do not match the approved payload.`
      );
    }
    appendAudit(paths, {
      event: "EXISTING_EXECUTION_RECOVERED",
      approvalId: approval.id,
      toolName,
      metadata: { executionId: existing.id },
    });
    return { executionId: existing.id, result: existing.result, recovered: true };
  }

  // Boundary 4 (content binding, independent of the caller): recompute the
  // hash of the stored proposedAction and refuse to run unless it exactly
  // matches `approvedArgsHash`. This is what stops a forged or tampered
  // record — status flipped to "approved" directly in the store, with
  // different arguments, or with no approvedArgsHash at all — from ever
  // reaching runTool.
  const argsHash = hashAction(toolName, args);
  if (!approval.approvedArgsHash || argsHash !== approval.approvedArgsHash) {
    appendAudit(paths, {
      event: "EXECUTION_BINDING_MISMATCH",
      approvalId: approval.id,
      toolName,
      metadata: {
        expected: approval.approvedArgsHash,
        actual: argsHash,
        stage: "pre-execution",
      },
    });
    throw new Error(
      `Refusing to execute "${toolName}" for ${approval.id}: stored arguments do not match the approved payload.`
    );
  }

  const executionId = nextExecutionId(paths);
  const resultId = nextResultId(paths, RESULT_ID_PREFIX[toolName], toolName);

  // runTool re-validates the arguments against the tool schema before calling.
  const result = runTool(toolName, args, resultId);

  saveExecution(paths, {
    id: executionId,
    approvalId: approval.id,
    toolName,
    arguments: args,
    argsHash,
    result,
    executedAt: nowIso(),
  });

  // `argsHash` is the content identity of what actually ran. In a real
  // payment integration, this is what you'd send downstream as the
  // idempotency key, so a retried call is deduplicated by content — not just
  // by approval ID, which a stale-view edit could have quietly changed.
  appendAudit(paths, {
    event: "ACTION_EXECUTED",
    approvalId: approval.id,
    toolName,
    metadata: { executionId, result, argsHash },
  });

  return { executionId, result, recovered: false };
}
