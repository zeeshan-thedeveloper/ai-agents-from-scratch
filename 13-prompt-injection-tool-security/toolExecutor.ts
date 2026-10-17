import type { AuditLog } from "./auditLog.js";
import { runTool, type MockEnvironment } from "./mockTools.js";
import { authorizeToolCall, denyUnknownTool, permittedTools } from "./policy.js";
import { createTrustedRequest } from "./requestContext.js";
import {
  ProposedToolCallSchema,
  ToolArgumentSchemas,
  ToolNameSchema,
  type DispatchResult,
  type PolicyDecision,
  type TrustedRequest,
  type ValidatedToolCall,
} from "./types.js";

// The tool dispatcher: the ONLY place a proposed tool call turns into a side
// effect. Agents (scripted or live) produce proposals; proposals come here.
//
// Two executors share everything — the same validation and the same mock
// tools — and differ in exactly one step: whether authorizeToolCall is asked
// before runTool. That single step is the security boundary this module is
// about.

export interface ToolExecutor {
  readonly mode: "protected" | "unsafe";
  dispatch(proposal: unknown): DispatchResult;
}

type ParseOutcome =
  | { ok: true; call: ValidatedToolCall }
  | { ok: false; kind: "unknown_tool"; toolName: string; arguments: unknown }
  | { ok: false; kind: "invalid"; toolName: string | null; error: string };

/**
 * Step 1–2 of dispatch, shared by both executors: is this a well-formed
 * proposal, for a tool we define, with arguments matching that tool's schema?
 *
 * Passing this step means the call is WELL-FORMED. It does not mean it is
 * AUTHORIZED. A perfectly valid sendReport call is still a sendReport call.
 */
function parseProposal(proposal: unknown): ParseOutcome {
  const envelope = ProposedToolCallSchema.safeParse(proposal);
  if (!envelope.success) {
    const name = (proposal as { toolName?: unknown } | null)?.toolName;
    return {
      ok: false,
      kind: "invalid",
      toolName: typeof name === "string" ? name : null,
      error: `Malformed proposal: ${formatZodError(envelope.error.issues)}`,
    };
  }

  const { toolName, arguments: args } = envelope.data;
  const known = ToolNameSchema.safeParse(toolName);
  if (!known.success) return { ok: false, kind: "unknown_tool", toolName, arguments: args };

  const parsedArgs = ToolArgumentSchemas[known.data].safeParse(args);
  if (!parsedArgs.success) {
    return {
      ok: false,
      kind: "invalid",
      toolName,
      error: `Invalid arguments for ${toolName}: ${formatZodError(parsedArgs.error.issues)}`,
    };
  }

  return { ok: true, call: { toolName: known.data, arguments: parsedArgs.data } as ValidatedToolCall };
}

function formatZodError(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

function execute(env: MockEnvironment, audit: AuditLog, call: ValidatedToolCall, policy?: PolicyDecision): DispatchResult {
  try {
    const output = runTool(env, call);
    audit.record("TOOL_EXECUTED", {
      toolName: call.toolName,
      metadata: { arguments: call.arguments, result: describeOutput(output) },
    });
    return { status: "executed", call, output, ...(policy ? { policy } : {}) };
  } catch (error) {
    const message = (error as Error).message;
    audit.record("TOOL_EXECUTION_FAILED", { toolName: call.toolName, metadata: { error: message } });
    return { status: "failed", toolName: call.toolName, error: message };
  }
}

// What the audit keeps about a tool's output: provenance and counts, not the
// full page text or report contents.
function describeOutput(output: ReturnType<typeof runTool>): Record<string, unknown> {
  switch (output.kind) {
    case "page":
      return {
        sourceId: output.content.sourceId,
        trust: output.content.trust,
        charCount: output.content.metadata.charCount,
      };
    case "summary":
      return { summaryChars: output.summary.length };
    case "report":
      return { ...output.report };
  }
}

function recordInvalid(audit: AuditLog, toolName: string | null, error: string): DispatchResult {
  audit.record("TOOL_CALL_INVALID", { toolName: toolName ?? "(unknown)", metadata: { error } });
  return { status: "invalid", toolName, error };
}

/**
 * The protected executor.
 *
 * The trusted request is bound ONCE, at construction, from the application's
 * own record of what the user asked for. It is re-validated and frozen here,
 * so later mutation of the caller's object changes nothing, and `dispatch`
 * has no parameter through which a caller — or a proposal — can supply a
 * different, more permissive context.
 *
 * For every proposal:
 *   1. validate the envelope and the tool name;   unknown tool → DENY
 *   2. validate the arguments with Zod;            malformed   → REJECT
 *   3. authorize against the trusted request;      not allowed → DENY
 *   4. only then run the tool
 *   5. audit every decision with its reason
 */
export function createProtectedExecutor(request: TrustedRequest, env: MockEnvironment, audit: AuditLog): ToolExecutor {
  const trusted = createTrustedRequest(structuredClone(request));

  return Object.freeze({
    mode: "protected" as const,
    dispatch(proposal: unknown): DispatchResult {
      const parsed = parseProposal(proposal);

      if (!parsed.ok && parsed.kind === "invalid") return recordInvalid(audit, parsed.toolName, parsed.error);

      const policy = parsed.ok ? authorizeToolCall(trusted, parsed.call) : denyUnknownTool(parsed.toolName);
      const toolName = parsed.ok ? parsed.call.toolName : parsed.toolName;
      const args = parsed.ok ? parsed.call.arguments : parsed.arguments;

      audit.record("POLICY_EVALUATED", {
        toolName,
        metadata: {
          requestId: trusted.requestId,
          taskType: trusted.taskType,
          permittedTools: [...permittedTools(trusted)],
          decision: policy.decision,
          rule: policy.rule,
          reason: policy.reason,
        },
      });

      if (!parsed.ok || policy.decision !== "allow") {
        audit.record("TOOL_EXECUTION_BLOCKED", {
          toolName,
          metadata: { arguments: args, rule: policy.rule, reason: policy.reason, sideEffect: "none" },
        });
        return { status: "blocked", toolName, arguments: args, policy };
      }

      return execute(env, audit, parsed.call, policy);
    },
  });
}

/**
 * ⚠️ INTENTIONALLY VULNERABLE — for the Demo B comparison only.
 *
 * This executor does what many first agent prototypes do: if the model asked
 * for a tool that exists, with arguments that validate, run it. It never asks
 * whether the user's request authorized that call. Schema validation is still
 * here, on purpose, to show that well-formed is not the same as permitted.
 *
 * Even here, the only "report delivery" is an in-memory array push.
 */
export function createUnsafeExecutor(env: MockEnvironment, audit: AuditLog): ToolExecutor {
  return Object.freeze({
    mode: "unsafe" as const,
    dispatch(proposal: unknown): DispatchResult {
      const parsed = parseProposal(proposal);
      if (!parsed.ok) {
        return parsed.kind === "invalid"
          ? recordInvalid(audit, parsed.toolName, parsed.error)
          : recordInvalid(audit, parsed.toolName, `There is no tool named "${parsed.toolName}" to run.`);
      }

      audit.record("AUTHORIZATION_SKIPPED", {
        toolName: parsed.call.toolName,
        metadata: {
          arguments: parsed.call.arguments,
          warning: "Unsafe executor: the proposal is executed without checking the user's request.",
        },
      });
      return execute(env, audit, parsed.call);
    },
  });
}
