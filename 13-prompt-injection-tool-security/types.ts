import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

// Every tool this application knows about. The agent is SHOWN all three —
// including the privileged sendReport — because real agents usually carry a
// broader toolbox than any single request needs. Which of them may run for a
// given request is decided later, in policy.ts, never here.
export const TOOL_NAMES = ["readWebPage", "submitSummary", "sendReport"] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

// RFC 2606 / RFC 6761 reserved names. They can never route to a real mailbox.
// This is a safety rail for the DEMO ITSELF — it guarantees that even the
// intentionally vulnerable path can only ever "send" to an address that does
// not exist. It is NOT the security control this module teaches; that is the
// authorization policy.
const RESERVED_EMAIL_DOMAIN = /(\.invalid|\.example|\.test|\.localhost|(^|\.)example\.(com|org|net))$/i;

const ReservedEmailSchema = z
  .string()
  .email("recipient must be an email address")
  .refine((value) => RESERVED_EMAIL_DOMAIN.test(value.split("@")[1] ?? ""), {
    message: "recipient must use a reserved example domain (demo safety rail: no real addresses)",
  });

// Argument schemas, one per tool. `.strict()` rejects any extra field, so an
// argument object cannot smuggle in something like `{ "authorized": true }`.
//
// Passing one of these schemas proves only that the arguments are WELL-FORMED.
// It says nothing about whether the call is AUTHORIZED.
export const ToolArgumentSchemas = {
  readWebPage: z.object({ url: z.string().url("url must be an absolute URL") }).strict(),
  submitSummary: z
    .object({ summary: z.string().trim().min(20, "summary is too short").max(2000, "summary is too long") })
    .strict(),
  sendReport: z
    .object({
      reportId: z.string().regex(/^DEMO-REPORT-\d{3}$/, 'reportId must look like "DEMO-REPORT-001"'),
      recipient: ReservedEmailSchema,
    })
    .strict(),
} satisfies Record<ToolName, z.ZodTypeAny>;

export type ToolArguments<T extends ToolName> = z.infer<(typeof ToolArgumentSchemas)[T]>;

/** A tool call whose name is known and whose arguments passed their schema. */
export type ValidatedToolCall = {
  [K in ToolName]: { toolName: K; arguments: ToolArguments<K> };
}[ToolName];

// The envelope of a proposal as it arrives from an agent (scripted or live).
// Deliberately loose on `toolName` (any string — unknown tools must reach the
// policy so they can be DENIED and audited, not silently dropped) and strict on
// shape: there is no field through which a proposal can claim it is allowed.
export const ProposedToolCallSchema = z
  .object({
    toolName: z.string().min(1, "toolName is required"),
    arguments: z.unknown(),
  })
  .strict();
export type ProposedToolCall = z.infer<typeof ProposedToolCallSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Trusted request context (the user's request, owned by the application)
// ─────────────────────────────────────────────────────────────────────────────

// The application, not the model, classifies what the user asked for. Each
// task type has its own fixed scope. There is intentionally no
// `allowedTools` field: capabilities are derived from `taskType` inside
// policy.ts, so there is nothing on the request for anyone to overwrite.
export const TaskTypeSchema = z.enum(["summarize_webpage", "send_report"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

const RequestIdSchema = z.string().regex(/^REQ-\d{3}$/, 'requestId must look like "REQ-001"');

export const TrustedRequestSchema = z.discriminatedUnion("taskType", [
  z
    .object({
      requestId: RequestIdSchema,
      taskType: z.literal("summarize_webpage"),
      userRequest: z.string().min(1),
      // The one page the user asked about. readWebPage is scoped to it.
      targetUrl: z.string().url(),
    })
    .strict(),
  z
    .object({
      requestId: RequestIdSchema,
      taskType: z.literal("send_report"),
      userRequest: z.string().min(1),
      // The exact report and recipient the USER named. sendReport is scoped to them.
      reportId: ToolArgumentSchemas.sendReport.shape.reportId,
      recipient: ToolArgumentSchemas.sendReport.shape.recipient,
    })
    .strict(),
]);
export type TrustedRequest = z.infer<typeof TrustedRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Untrusted external content
// ─────────────────────────────────────────────────────────────────────────────

// Retrieved content keeps its provenance. `trust` is a literal: there is no
// code path that produces "trusted" external content.
export const ExternalContentSchema = z
  .object({
    sourceId: z.string(),
    sourceUrl: z.string().url(),
    // Local file the offline fixture web served this from. Never shown to the
    // model — the file name would give the scenario away.
    fixturePath: z.string(),
    trust: z.literal("untrusted"),
    contentType: z.literal("text/html"),
    title: z.string(),
    text: z.string(),
    metadata: z
      .object({
        charCount: z.number().int().nonnegative(),
        sha256: z.string().length(64),
      })
      .strict(),
  })
  .strict();
export type ExternalContent = z.infer<typeof ExternalContentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Policy decisions
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyRule =
  | "TASK_PERMITS_TOOL"
  | "UNKNOWN_TOOL"
  | "TOOL_NOT_PERMITTED_FOR_TASK"
  | "URL_OUTSIDE_REQUEST_SCOPE"
  | "REPORT_NOT_REQUESTED_BY_USER";

export interface PolicyDecision {
  decision: "allow" | "deny";
  rule: PolicyRule;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool outputs and dispatch results
// ─────────────────────────────────────────────────────────────────────────────

export interface SentReport {
  reportId: string;
  recipient: string;
  recordCount: number;
  // Always the in-process array. There is no other delivery channel.
  channel: "local-mock-outbox";
}

export type ToolOutput =
  | { kind: "page"; content: ExternalContent }
  | { kind: "summary"; summary: string }
  | { kind: "report"; report: SentReport };

export type DispatchResult =
  | {
      status: "executed";
      call: ValidatedToolCall;
      output: ToolOutput;
      // undefined only on the intentionally vulnerable executor, which never asks.
      policy?: PolicyDecision;
    }
  | { status: "blocked"; toolName: string; arguments: unknown; policy: PolicyDecision }
  | { status: "invalid"; toolName: string | null; error: string }
  | { status: "failed"; toolName: ToolName; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Audit trace
// ─────────────────────────────────────────────────────────────────────────────

export const AuditEventTypeSchema = z.enum([
  "USER_REQUEST_RECEIVED",
  "EXTERNAL_CONTENT_LOADED",
  "TOOL_CALL_PROPOSED",
  "TOOL_CALL_INVALID",
  "POLICY_EVALUATED",
  "AUTHORIZATION_SKIPPED",
  "TOOL_EXECUTED",
  "TOOL_EXECUTION_BLOCKED",
  "TOOL_EXECUTION_FAILED",
  "SUMMARY_COMPLETED",
  // An answer was produced before the target page was ever read.
  "ANSWER_NOT_GROUNDED",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export interface AuditEvent {
  seq: number;
  event: AuditEventType;
  timestamp: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
}
