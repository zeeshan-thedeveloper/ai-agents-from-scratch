import { appendAudit } from "./auditLog.js";
import {
  findApproval,
  findExecutionByApprovalId,
  loadApprovals,
  nextApprovalId,
  upsertApproval,
} from "./approvalStore.js";
import type { DataPaths } from "./config.js";
import { executeAction, type ExecutionOutcome } from "./executor.js";
import { evaluatePolicy } from "./policy.js";
import {
  ActionProposalSchema,
  type ActionProposal,
  type ApprovalRecord,
  type PolicyResult,
  type ProposedAction,
} from "./types.js";
import { hashAction, nowIso, writeJsonArray } from "./utils.js";

// The approval service is the orchestration layer. It ties together the model
// proposal, the policy gate, persistence, and execution — but each of those
// responsibilities lives in its own module. This file owns the lifecycle:
// propose → gate → (pending) → edit → approve/reject → execute-once → audit.
//
// Approval binds to content, not to the record ID. Every record carries
// `argsHash` (the hash of its current proposedAction) and, once approved,
// `approvedArgsHash` (the hash a human actually signed off on). Any edit
// changes `argsHash`; approving requires the caller to name the exact hash
// they reviewed, so a reviewer who is looking at a stale view of the record
// cannot unknowingly approve a payload someone else has since changed.

// Record fields a human editor must never be able to change through the edit
// command. Only tool arguments are editable; identity, status, timestamps, the
// chosen tool, and the execution link are off limits.
const PROTECTED_EDIT_FIELDS = new Set([
  "id",
  "status",
  "createdAt",
  "updatedAt",
  "toolName",
  "executionId",
  "decisionReason",
  "proposedAction",
  "originalRequest",
  "revision",
  "argsHash",
  "approvedArgsHash",
  "approvedAt",
]);

// Argument fields that must be coerced from CLI strings to numbers before
// re-validation. Everything else stays a string.
const NUMERIC_ARG_FIELDS = new Set(["amount"]);

/**
 * Thrown when a caller's `expectedArgsHash` does not match the record's
 * current content hash — the record changed since the caller last saw it (or
 * they never saw it at all). The message is written for a human reviewer.
 */
export class ArgsHashMismatchError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(
      `${approvalId} changed since you reviewed it (expected ${expected.slice(0, 8)}…, now ${actual.slice(0, 8)}…). Run \`npm run approvals\` and review again.`
    );
    this.name = "ArgsHashMismatchError";
  }
}

export type ProposalOutcome =
  | {
      kind: "auto_executed";
      record: ApprovalRecord;
      policy: PolicyResult;
      execution: ExecutionOutcome;
    }
  | {
      kind: "pending";
      record: ApprovalRecord;
      policy: PolicyResult;
      duplicateOf?: string;
    }
  | { kind: "denied"; policy: PolicyResult; toolName: ActionProposal["toolName"] };

function toProposedAction(proposal: ActionProposal): ProposedAction {
  return {
    toolName: proposal.toolName,
    arguments: proposal.arguments,
    reason: proposal.reason,
  };
}

/**
 * Take a validated model proposal and route it through the policy gate.
 *
 * - `deny`  → audited and refused. No record is created; the tool is never
 *   reachable.
 * - `auto_execute` → executed immediately and recorded as executed. The
 *   policy itself is the approver, so `approvedArgsHash` is set to the
 *   proposal's own hash — the policy approves exactly this payload.
 * - `require_approval` → a pending approval record is persisted for a human.
 *   If an identical pending approval already exists for the same request (same
 *   content hash), it is reused rather than duplicated (so re-running the demo
 *   does not pile up copies).
 *
 * The proposal is re-validated here even though it is already typed, so this
 * function is safe to call with data loaded from disk or built in a test.
 */
export function handleProposal(
  paths: DataPaths,
  originalRequest: string,
  rawProposal: unknown
): ProposalOutcome {
  const proposal = ActionProposalSchema.parse(rawProposal);
  const proposedAction = toProposedAction(proposal);
  const argsHash = hashAction(proposal.toolName, proposal.arguments);

  appendAudit(paths, {
    event: "ACTION_PROPOSED",
    toolName: proposal.toolName,
    metadata: { originalRequest, arguments: proposal.arguments },
  });

  const policy = evaluatePolicy(proposal.toolName);
  appendAudit(paths, {
    event: "POLICY_EVALUATED",
    toolName: proposal.toolName,
    metadata: { decision: policy.decision, reason: policy.reason },
  });

  if (policy.decision === "deny") {
    // Forbidden: no executable record is ever created. Record an explicit
    // denial event so the refusal is visible in the audit trail.
    appendAudit(paths, {
      event: "ACTION_DENIED",
      toolName: proposal.toolName,
      metadata: { originalRequest, reason: policy.reason },
    });
    return { kind: "denied", policy, toolName: proposal.toolName };
  }

  if (policy.decision === "auto_execute") {
    // The policy itself authorizes this action, so it goes straight to
    // `approved` — but NOT to `executed` until the tool actually succeeds. If
    // execution throws, the record truthfully stays `approved`, never falsely
    // `executed`.
    const now = nowIso();
    const approved: ApprovalRecord = {
      id: nextApprovalId(paths),
      originalRequest,
      proposedAction,
      status: "approved",
      revision: 1,
      argsHash,
      approvedArgsHash: argsHash,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    upsertApproval(paths, approved);
    appendAudit(paths, {
      event: "ACTION_APPROVED",
      approvalId: approved.id,
      toolName: approved.proposedAction.toolName,
      metadata: { authorizedBy: "policy" },
    });

    const execution = executeAction(paths, approved.id);
    const executed: ApprovalRecord = {
      ...approved,
      status: "executed",
      executionId: execution.executionId,
      updatedAt: nowIso(),
    };
    upsertApproval(paths, executed);
    return { kind: "auto_executed", record: executed, policy, execution };
  }

  // require_approval: reuse an identical pending record if one already exists
  // (same request, same tool, same content hash).
  const duplicate = loadApprovals(paths).find(
    (existing) =>
      existing.status === "pending" &&
      existing.originalRequest === originalRequest &&
      existing.proposedAction.toolName === proposedAction.toolName &&
      existing.argsHash === argsHash
  );
  if (duplicate) {
    return { kind: "pending", record: duplicate, policy, duplicateOf: duplicate.id };
  }

  const now = nowIso();
  const record: ApprovalRecord = {
    id: nextApprovalId(paths),
    originalRequest,
    proposedAction,
    status: "pending",
    revision: 1,
    argsHash,
    createdAt: now,
    updatedAt: now,
  };
  upsertApproval(paths, record);

  appendAudit(paths, {
    event: "APPROVAL_REQUESTED",
    approvalId: record.id,
    toolName: record.proposedAction.toolName,
  });

  return { kind: "pending", record, policy };
}

export interface EditResult {
  record: ApprovalRecord;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Edit the arguments of a pending approval.
 *
 * The caller must name `expectedArgsHash`: the content hash of the record as
 * they last saw it. If the record has changed since then (someone else edited
 * it, or the caller is working from a stale view), this throws instead of
 * silently editing whatever happens to be stored now.
 *
 * The edit itself is a human business decision (for example, deciding a €49
 * partial refund is appropriate), not a model correction. Only tool arguments
 * may change; protected record fields are rejected. The merged arguments are
 * re-validated against the tool schema, so an invalid edit (a negative amount,
 * an unknown field) fails before it is saved. The record stays pending, and a
 * successful edit produces a new content hash and bumps `revision`.
 */
export function editApproval(
  paths: DataPaths,
  id: string,
  edits: Record<string, string>,
  expectedArgsHash: string
): EditResult {
  const record = requirePending(paths, id, "edit");

  if (record.argsHash !== expectedArgsHash) {
    appendAudit(paths, {
      event: "APPROVAL_BINDING_MISMATCH",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { expected: expectedArgsHash, actual: record.argsHash, stage: "edit" },
    });
    throw new ArgsHashMismatchError(record.id, expectedArgsHash, record.argsHash);
  }

  for (const key of Object.keys(edits)) {
    if (PROTECTED_EDIT_FIELDS.has(key)) {
      throw new Error(
        `Cannot edit protected field "${key}". Only tool arguments may be edited.`
      );
    }
  }

  const before = { ...record.proposedAction.arguments };

  // Merge the edits over the current arguments, coercing numeric fields.
  const mergedArgs: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(edits)) {
    mergedArgs[key] = NUMERIC_ARG_FIELDS.has(key) ? coerceNumber(key, value) : value;
  }

  // Re-validate the whole action. A bad edit (negative amount, wrong currency,
  // unknown field) throws here and nothing is persisted.
  const revalidated = ActionProposalSchema.parse({
    toolName: record.proposedAction.toolName,
    arguments: mergedArgs,
    reason: record.proposedAction.reason,
  });

  const newArgsHash = hashAction(revalidated.toolName, revalidated.arguments);

  const updated: ApprovalRecord = {
    ...record,
    proposedAction: toProposedAction(revalidated),
    argsHash: newArgsHash,
    revision: record.revision + 1,
    updatedAt: nowIso(),
  };
  upsertApproval(paths, updated);

  appendAudit(paths, {
    event: "ACTION_EDITED",
    approvalId: updated.id,
    toolName: updated.proposedAction.toolName,
    metadata: {
      before,
      after: updated.proposedAction.arguments,
      beforeHash: record.argsHash,
      afterHash: newArgsHash,
    },
  });

  return { record: updated, before, after: updated.proposedAction.arguments };
}

export interface ApproveResult {
  record: ApprovalRecord;
  execution?: ExecutionOutcome;
  blocked: boolean;
}

/**
 * Approve a pending record: grant permission, then execute its tool once.
 *
 * The caller must name `expectedArgsHash`: the exact content hash they
 * reviewed. Approval binds to that payload, not to the record ID — if the
 * stored record has since changed (someone edited it after the caller looked
 * at it, or the caller is approving from a stale view), this refuses instead
 * of executing whatever the record now happens to contain.
 *
 * State transition: `pending → approved → executed`. Permission is granted
 * (and persisted as `approved`) BEFORE the tool runs, and the record only
 * becomes `executed` after the tool succeeds — so the state is always truthful.
 *
 * Idempotency / recovery:
 *  - a record already `executed` blocks the duplicate (DUPLICATE_EXECUTION_BLOCKED);
 *  - if an execution already exists for this approval (e.g. a crash between
 *    saving the execution and flipping the status), the existing result is
 *    reconciled and reused instead of running the tool again — but only if its
 *    arguments still match what was approved.
 *
 * Before granting approval, the action is re-validated and the policy is
 * re-evaluated: the tool must still be classified exactly `require_approval`, so
 * a policy that drifted to `deny` or `auto_execute` cannot execute through this
 * stored workflow.
 */
export function approveApproval(
  paths: DataPaths,
  id: string,
  expectedArgsHash: string
): ApproveResult {
  const record = requireExisting(paths, id);

  // Idempotency guard: already executed → block the duplicate, do not re-run.
  if (record.status === "executed") {
    appendAudit(paths, {
      event: "DUPLICATE_EXECUTION_BLOCKED",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { executionId: record.executionId },
    });
    return { record, blocked: true };
  }

  // Recovery: an execution already exists but the record never advanced to
  // `executed`. Reuse it only if it was produced from the payload that was
  // actually approved — never reconcile onto an execution that ran something
  // else.
  const priorExecution = findExecutionByApprovalId(paths, record.id);
  if (priorExecution) {
    const expectedForRecovery = record.approvedArgsHash ?? record.argsHash;
    if (priorExecution.argsHash !== expectedForRecovery) {
      appendAudit(paths, {
        event: "EXECUTION_BINDING_MISMATCH",
        approvalId: record.id,
        toolName: record.proposedAction.toolName,
        metadata: {
          expected: expectedForRecovery,
          actual: priorExecution.argsHash,
          stage: "recovery",
        },
      });
      throw new Error(
        `Refusing to recover execution for ${id}: the recorded execution's arguments (${priorExecution.argsHash.slice(0, 12)}…) do not match what was approved (${expectedForRecovery.slice(0, 12)}…).`
      );
    }
    const reconciled: ApprovalRecord = {
      ...record,
      status: "executed",
      executionId: priorExecution.id,
      updatedAt: nowIso(),
    };
    upsertApproval(paths, reconciled);
    appendAudit(paths, {
      event: "EXISTING_EXECUTION_RECOVERED",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { executionId: priorExecution.id },
    });
    return {
      record: reconciled,
      execution: {
        executionId: priorExecution.id,
        result: priorExecution.result,
        recovered: true,
      },
      blocked: false,
    };
  }

  if (record.status !== "pending") {
    throw new Error(
      `Approval ${id} is "${record.status}", not "pending". It cannot be approved.`
    );
  }

  // Content binding: recompute the hash from the stored proposedAction. This
  // must match the record's own stored hash (store integrity — the argsHash
  // field wasn't corrupted or left stale relative to the arguments) AND the
  // hash the caller says they reviewed (expectedArgsHash — they are not
  // approving a payload someone else has since changed). Any mismatch stops
  // here: nothing is persisted as approved, nothing executes.
  const recomputed = hashAction(record.proposedAction.toolName, record.proposedAction.arguments);
  if (recomputed !== record.argsHash) {
    appendAudit(paths, {
      event: "APPROVAL_BINDING_MISMATCH",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { expected: record.argsHash, actual: recomputed, stage: "store-integrity" },
    });
    throw new ArgsHashMismatchError(record.id, record.argsHash, recomputed);
  }
  if (recomputed !== expectedArgsHash) {
    appendAudit(paths, {
      event: "APPROVAL_BINDING_MISMATCH",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { expected: expectedArgsHash, actual: recomputed, stage: "reviewer-view" },
    });
    throw new ArgsHashMismatchError(record.id, expectedArgsHash, recomputed);
  }

  // Re-validate the action and re-evaluate the policy at approval time.
  ActionProposalSchema.parse({
    toolName: record.proposedAction.toolName,
    arguments: record.proposedAction.arguments,
    reason: record.proposedAction.reason,
  });

  // The stored workflow must still match the current policy exactly. If the
  // tool is no longer `require_approval`, the human-approval path is invalid.
  const policy = evaluatePolicy(record.proposedAction.toolName);
  if (policy.decision !== "require_approval") {
    throw new Error(
      `Approval ${id} cannot continue because "${record.proposedAction.toolName}" is no longer classified as require_approval (now "${policy.decision}").`
    );
  }

  // Grant permission first: pending → approved. approvedArgsHash pins exactly
  // the payload that was reviewed.
  const now = nowIso();
  const approved: ApprovalRecord = {
    ...record,
    status: "approved",
    approvedArgsHash: recomputed,
    approvedAt: now,
    updatedAt: now,
  };
  upsertApproval(paths, approved);
  appendAudit(paths, {
    event: "ACTION_APPROVED",
    approvalId: approved.id,
    toolName: approved.proposedAction.toolName,
    metadata: { authorizedBy: "human" },
  });

  // Execute by ID. The executor reloads the record itself and defends the
  // boundary again — it never trusts this in-memory `approved` object.
  const execution = executeAction(paths, approved.id);

  const executed: ApprovalRecord = {
    ...approved,
    status: "executed",
    executionId: execution.executionId,
    updatedAt: nowIso(),
  };
  upsertApproval(paths, executed);

  return { record: executed, execution, blocked: false };
}

/**
 * Reject a pending approval with a reason. The tool is never executed, and the
 * record can no longer be approved unless a new approval is created.
 */
export function rejectApproval(
  paths: DataPaths,
  id: string,
  reason: string
): ApprovalRecord {
  if (!reason || reason.trim() === "") {
    throw new Error('A rejection reason is required (use --reason="...").');
  }
  const record = requirePending(paths, id, "reject");

  const rejected: ApprovalRecord = {
    ...record,
    status: "rejected",
    decisionReason: reason,
    updatedAt: nowIso(),
  };
  upsertApproval(paths, rejected);

  appendAudit(paths, {
    event: "ACTION_REJECTED",
    approvalId: rejected.id,
    toolName: rejected.proposedAction.toolName,
    metadata: { reason },
  });

  return rejected;
}

/** Restore a clean, empty demo state across all three stores. */
export function resetDemo(paths: DataPaths): void {
  writeJsonArray(paths.approvals, []);
  writeJsonArray(paths.audit, []);
  writeJsonArray(paths.executions, []);
}

// ── internal helpers ─────────────────────────────────────────────────────────

function requireExisting(paths: DataPaths, id: string): ApprovalRecord {
  const record = findApproval(paths, id);
  if (!record) {
    throw new Error(`No approval found with id "${id}".`);
  }
  return record;
}

function requirePending(
  paths: DataPaths,
  id: string,
  action: string
): ApprovalRecord {
  const record = requireExisting(paths, id);
  if (record.status !== "pending") {
    throw new Error(
      `Cannot ${action} approval ${id}: it is "${record.status}", not "pending".`
    );
  }
  return record;
}

function coerceNumber(field: string, value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Field "${field}" must be a number, got "${value}".`);
  }
  return parsed;
}
