import type { AuditEvent, AuditEventType } from "./types.js";
import { redactSecrets } from "./utils.js";

// An in-memory, append-only audit trace for one run. It records what was
// requested, what external content entered the agent's context, what the
// agent proposed, what the policy decided and why, and what actually ran.
//
// Every event passes through redactSecrets before it is stored. Store tool
// names, arguments, source IDs, and decisions — never credentials.

export class AuditLog {
  private readonly entries: AuditEvent[] = [];

  record(event: AuditEventType, details: { toolName?: string; metadata?: Record<string, unknown> } = {}): void {
    this.entries.push({
      seq: this.entries.length + 1,
      event,
      timestamp: new Date().toISOString(),
      ...(details.toolName !== undefined ? { toolName: details.toolName } : {}),
      ...(details.metadata ? { metadata: redactSecrets(details.metadata) as Record<string, unknown> } : {}),
    });
  }

  /** A copy of the trace. Callers cannot rewrite history through it. */
  events(): AuditEvent[] {
    return structuredClone(this.entries);
  }
}
