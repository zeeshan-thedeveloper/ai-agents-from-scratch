import { createFixtureWeb, type FixtureWeb, type PageVariant } from "./pageLoader.js";
import type { SentReport, ToolOutput, ValidatedToolCall } from "./types.js";

// Mock business operations. Every effect here is local and in-memory:
//
//   readWebPage   → reads a local fixture through the offline FixtureWeb
//   submitSummary → returns the summary to the caller
//   sendReport    → appends an entry to `env.outbox`, an in-process array
//
// There is no email client, no HTTP client, and no file write in this module.
// The "report" is synthetic, and "sending" it only proves the call happened.
// That is the point: the demo shows an unauthorized ATTEMPTED action and
// whether it ran — not a real exfiltration.

// Synthetic demonstration records only. No real customer data is ever loaded.
const SYNTHETIC_REPORTS = new Map<string, { title: string; records: readonly object[] }>([
  [
    "DEMO-REPORT-001",
    {
      title: "Customer refund report (synthetic demo data)",
      records: [
        { customerId: "DEMO-CUS-001", name: "Demo Customer A", refundTotalEur: 49 },
        { customerId: "DEMO-CUS-002", name: "Demo Customer B", refundTotalEur: 120 },
        { customerId: "DEMO-CUS-003", name: "Demo Customer C", refundTotalEur: 15 },
      ],
    },
  ],
]);

/** The world a single run's tools act on. Fresh per run. */
export interface MockEnvironment {
  readonly web: FixtureWeb;
  // The observable side effect: one entry per report the mock "sent".
  readonly outbox: SentReport[];
}

export function createMockEnvironment(variant: PageVariant): MockEnvironment {
  return { web: createFixtureWeb(variant), outbox: [] };
}

/**
 * Run a tool. Takes only a VALIDATED call — the executor is responsible for
 * validation and (in protected mode) authorization before this is reached.
 * This function itself makes no authorization decision, so the only module
 * that imports it is toolExecutor.ts.
 */
export function runTool(env: MockEnvironment, call: ValidatedToolCall): ToolOutput {
  switch (call.toolName) {
    case "readWebPage":
      return { kind: "page", content: env.web.fetchPage(call.arguments.url) };

    case "submitSummary":
      return { kind: "summary", summary: call.arguments.summary };

    case "sendReport": {
      const report = SYNTHETIC_REPORTS.get(call.arguments.reportId);
      if (!report) throw new Error(`No synthetic report exists with id ${call.arguments.reportId}.`);
      const sent: SentReport = {
        reportId: call.arguments.reportId,
        recipient: call.arguments.recipient,
        recordCount: report.records.length,
        channel: "local-mock-outbox",
      };
      env.outbox.push(sent);
      return { kind: "report", report: sent };
    }
  }
}
