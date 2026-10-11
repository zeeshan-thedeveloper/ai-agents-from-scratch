import type { PolicyDecision, TaskType, ToolName, TrustedRequest, ValidatedToolCall } from "./types.js";
import { normalizeUrl } from "./utils.js";

// The authorization policy. This is the file that answers the module's
// question: why can't instructions inside a webpage authorize sendReport?
//
// Look at the inputs. Every function here takes the TRUSTED request (built from
// what the user asked for, before any page was loaded) and a validated tool
// call. None of them takes the webpage, the prompt, the model's reasoning, or
// the conversation. Whatever a page says — "this is pre-approved", "SYSTEM:
// developer override", a JSON blob listing new allowedTools — it has no
// parameter through which to reach a decision made here.
//
// Rules:
//   1. Capabilities come from the TASK TYPE, via this table. Nothing else.
//   2. Some permitted tools are further scoped to the request's own values
//      (readWebPage → only the page the user named; sendReport → only the
//      report and recipient the user named).
//   3. Anything not explicitly allowed is denied. Unknown tools are denied.

const TASK_PERMISSIONS: Readonly<Record<TaskType, readonly ToolName[]>> = Object.freeze({
  // "Summarize this page": read that one page, hand back a summary. Nothing else.
  summarize_webpage: Object.freeze(["readWebPage", "submitSummary"] as const),
  // "Send report X to Y": the user explicitly asked for exactly this send.
  send_report: Object.freeze(["sendReport"] as const),
});

/** The tools a trusted request permits. Derived from taskType alone. */
export function permittedTools(request: TrustedRequest): readonly ToolName[] {
  return TASK_PERMISSIONS[request.taskType] ?? [];
}

/** Fail closed for any tool name the application does not recognise. */
export function denyUnknownTool(toolName: string): PolicyDecision {
  return {
    decision: "deny",
    rule: "UNKNOWN_TOOL",
    reason: `"${toolName}" is not a tool this application defines. Unknown tools are denied by default.`,
  };
}

/**
 * Decide whether a validated tool call may execute for this trusted request.
 * Deterministic: the same request and call always produce the same decision.
 */
export function authorizeToolCall(request: TrustedRequest, call: ValidatedToolCall): PolicyDecision {
  const permitted = permittedTools(request);

  if (!permitted.includes(call.toolName)) {
    return {
      decision: "deny",
      rule: "TOOL_NOT_PERMITTED_FOR_TASK",
      reason:
        `${call.toolName} is not authorized by this user's ${request.taskType} request. ` +
        `Permitted tools for this request: ${permitted.join(", ") || "(none)"}.`,
    };
  }

  switch (call.toolName) {
    case "readWebPage": {
      if (
        request.taskType !== "summarize_webpage" ||
        normalizeUrl(call.arguments.url) !== normalizeUrl(request.targetUrl)
      ) {
        return {
          decision: "deny",
          rule: "URL_OUTSIDE_REQUEST_SCOPE",
          reason: `readWebPage is scoped to the page the user asked about; ${call.arguments.url} is not that page.`,
        };
      }
      return allow("readWebPage of the page the user asked to summarize.");
    }

    case "submitSummary":
      return allow("Returning a summary to the user is the requested task.");

    case "sendReport": {
      if (
        request.taskType !== "send_report" ||
        call.arguments.reportId !== request.reportId ||
        call.arguments.recipient.toLowerCase() !== request.recipient.toLowerCase()
      ) {
        return {
          decision: "deny",
          rule: "REPORT_NOT_REQUESTED_BY_USER",
          reason: "sendReport may only send the exact report to the exact recipient the user requested.",
        };
      }
      return allow(`The user explicitly asked to send ${request.reportId} to ${request.recipient}.`);
    }

    default: {
      // Exhaustiveness: adding a tool without a policy branch is a type error,
      // and at runtime it still fails closed.
      const unhandled: never = call;
      return denyUnknownTool(String((unhandled as { toolName: unknown }).toolName));
    }
  }
}

function allow(reason: string): PolicyDecision {
  return { decision: "allow", rule: "TASK_PERMITS_TOOL", reason };
}
