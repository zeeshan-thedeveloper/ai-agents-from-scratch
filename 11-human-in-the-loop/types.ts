import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

// The supported tools are a closed enum. The model may only propose one of
// these; anything else is rejected at the validation boundary before it can
// ever reach a policy check or an executor.
export const ToolNameSchema = z.enum([
  "getOrderStatus",
  "refundOrder",
  "cancelSubscription",
  "deleteProductionUsers",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

// Shared ID shapes. Malformed IDs fail here rather than reaching a tool.
const OrderIdSchema = z
  .string()
  .regex(/^ORD-\d+$/, 'orderId must look like "ORD-001"');
const CustomerIdSchema = z
  .string()
  .regex(/^CUS-\d+$/, 'customerId must look like "CUS-104"');

// ─────────────────────────────────────────────────────────────────────────────
// Action proposal (the model's output)
// ─────────────────────────────────────────────────────────────────────────────

// A discriminated union on `toolName`. Each tool has its own argument shape, so
// the wrong arguments for a tool fail validation. `.strict()` is applied at BOTH
// levels: the arguments object and the outer proposal object. The outer
// `.strict()` is what rejects a hidden permission field like `requiresApproval`,
// `isAuthorized`, or `allowed` — the model is never allowed to decide those.
// The model proposes capability; the application owns authorization.
export const ActionProposalSchema = z.discriminatedUnion("toolName", [
  z
    .object({
      toolName: z.literal("getOrderStatus"),
      arguments: z.object({ orderId: OrderIdSchema }).strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("refundOrder"),
      arguments: z
        .object({
          orderId: OrderIdSchema,
          amount: z.number().positive("refund amount must be greater than 0"),
          currency: z.literal("EUR", {
            errorMap: () => ({ message: 'currency must be "EUR"' }),
          }),
          reason: z.string().min(1),
        })
        .strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("cancelSubscription"),
      arguments: z
        .object({
          customerId: CustomerIdSchema,
          reason: z.string().min(1),
        })
        .strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("deleteProductionUsers"),
      arguments: z.object({}).strict(),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────────

// The three outcomes of the deterministic policy gate. This is decided by
// application code, never by the model.
export const PolicyDecisionSchema = z.enum([
  "auto_execute",
  "require_approval",
  "deny",
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval records (persisted workflow state)
// ─────────────────────────────────────────────────────────────────────────────

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "executed",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// The action as stored on the record. Arguments are kept as an open record here
// because a record can hold any tool's arguments; the exact shape is
// re-validated with ActionProposalSchema every time the action is about to
// change or execute.
export const ProposedActionSchema = z.object({
  toolName: ToolNameSchema,
  arguments: z.record(z.unknown()),
  reason: z.string(),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string(),
  originalRequest: z.string(),
  proposedAction: ProposedActionSchema,
  status: ApprovalStatusSchema,
  // Content-binding fields (see utils.ts `hashAction`). An approval binds to
  // one exact {toolName, arguments} payload, not to the record ID: `argsHash`
  // is that payload's hash, `revision` counts edits, and `approvedArgsHash` is
  // the hash a human actually approved — set only once the record moves to
  // `approved`, and compared against the stored hash before every execution.
  revision: z.number().int().positive(),
  argsHash: z.string().length(64),
  approvedArgsHash: z.string().length(64).optional(),
  approvedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  decisionReason: z.string().optional(),
  executionId: z.string().optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Executions
// ─────────────────────────────────────────────────────────────────────────────

export const ExecutionRecordSchema = z.object({
  id: z.string(),
  approvalId: z.string(),
  toolName: ToolNameSchema,
  arguments: z.record(z.unknown()),
  argsHash: z.string().length(64),
  result: z.record(z.unknown()),
  executedAt: z.string(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

export const AuditEventTypeSchema = z.enum([
  "ACTION_PROPOSED",
  "POLICY_EVALUATED",
  "APPROVAL_REQUESTED",
  "ACTION_EDITED",
  "ACTION_APPROVED",
  "ACTION_REJECTED",
  "ACTION_DENIED",
  "ACTION_EXECUTED",
  "DUPLICATE_EXECUTION_BLOCKED",
  "EXISTING_EXECUTION_RECOVERED",
  "APPROVAL_BINDING_MISMATCH",
  "EXECUTION_BINDING_MISMATCH",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  event: AuditEventTypeSchema,
  timestamp: z.string(),
  approvalId: z.string().optional(),
  toolName: ToolNameSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
