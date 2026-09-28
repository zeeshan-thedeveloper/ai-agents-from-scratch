import { fileURLToPath } from "node:url";

import {
  approveApproval,
  editApproval,
  rejectApproval,
  resetDemo,
} from "./approvalService.js";
import { findApproval, loadApprovals } from "./approvalStore.js";
import { loadAudit } from "./auditLog.js";
import { defaultPaths, type DataPaths } from "./config.js";
import { prettyJson, printSection } from "./utils.js";

// --expect accepts either the full 64-char content hash or a prefix of at
// least this many characters — long enough to make a collision practically
// impossible in this demo's small ID space, short enough to type by hand.
const MIN_HASH_PREFIX_LENGTH = 12;

/**
 * Resolve a CLI-provided --expect value against the approval's currently
 * stored hash.
 *
 * A prefix that matches the start of the current hash is expanded to the full
 * hash, so the common "list, then immediately approve" flow works without
 * typing all 64 characters. A value that does not match what's currently
 * stored (or a full stale hash from before an edit) is passed through
 * unchanged, so editApproval/approveApproval's own binding check reports —
 * and audits — the mismatch, rather than the CLI silently swallowing it.
 */
export function resolveExpectedHash(paths: DataPaths, id: string, provided: string): string {
  if (provided.length < MIN_HASH_PREFIX_LENGTH) {
    throw new Error(
      `--expect must be at least ${MIN_HASH_PREFIX_LENGTH} characters (a hash prefix) or the full 64-character hash, got "${provided}" (${provided.length} characters).`
    );
  }
  const record = findApproval(paths, id);
  if (record && record.argsHash.startsWith(provided)) {
    return record.argsHash;
  }
  return provided;
}

function requireExpectedHash(
  paths: DataPaths,
  id: string,
  flags: Record<string, string>
): string {
  const provided = flags.expect;
  if (!provided) {
    throw new Error(
      `Missing --expect=<hash>. Run "npm run approvals" to see the current hash, then pass --expect=<hash-or-prefix>.`
    );
  }
  return resolveExpectedHash(paths, id, provided);
}

// A small command-line interface over the approval lifecycle. Each npm script
// maps to one subcommand: list, edit, approve, reject, audit, reset. The
// proposal step itself lives in index.ts (npm start), because it is the only
// part that calls the model.

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

/** Parse "APR-001 --amount=49 --reason=Text" and "--reason Text" into args. */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[body] = argv[++i];
      } else {
        flags[body] = "true";
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0];
  if (!id) {
    throw new Error(`Missing approval id. Usage: npm run ${command} -- APR-001`);
  }
  return id;
}

function main(): void {
  const paths = defaultPaths();
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  switch (command) {
    case "list": {
      const approvals = loadApprovals(paths);
      printSection("Approvals");
      if (approvals.length === 0) {
        console.log("No approvals yet. Create one with \"npm start\".");
        break;
      }
      for (const record of approvals) {
        const args = prettyJson(record.proposedAction.arguments).replace(/\n/g, "\n    ");
        console.log(
          `- ${record.id}  [${record.status}]  rev ${record.revision}  ${record.argsHash.slice(0, 12)}  ${record.proposedAction.toolName}` +
            (record.executionId ? `  → ${record.executionId}` : "") +
            `\n    ${args}`
        );
      }
      break;
    }

    case "edit": {
      const id = requireId(positionals, "edit");
      const expectedArgsHash = requireExpectedHash(paths, id, flags);
      // Every other flag is passed through as an argument edit; the service
      // rejects any protected field and re-validates the merged arguments.
      // `expect` itself is stripped so it is never treated as a tool argument.
      const { expect: _expect, ...editFlags } = flags;
      const { record, before, after } = editApproval(paths, id, editFlags, expectedArgsHash);
      printSection(`Edited ${id}`);
      console.log("Before:");
      console.log(prettyJson(before));
      console.log("\nAfter:");
      console.log(prettyJson(after));
      console.log(`\nNew hash: ${record.argsHash}`);
      console.log(
        `Approve this exact version with:\n  npm run approve -- ${id} --expect=${record.argsHash.slice(0, 12)}`
      );
      console.log("\nStill pending. Re-validated. Nothing has executed yet.");
      break;
    }

    case "approve": {
      const id = requireId(positionals, "approve");
      const expectedArgsHash = requireExpectedHash(paths, id, flags);
      const outcome = approveApproval(paths, id, expectedArgsHash);
      if (outcome.blocked) {
        printSection(`Approve ${id}`);
        console.log(
          `Already executed as ${outcome.record.executionId}. ` +
            "Duplicate execution blocked — the tool was not called again."
        );
        break;
      }
      if (outcome.execution?.recovered) {
        printSection(`Approve ${id}`);
        console.log(
          `An execution already existed for this approval (${outcome.execution.executionId}). ` +
            "Reused it — the tool was not called again. Record reconciled to executed."
        );
        console.log(prettyJson(outcome.execution.result));
        break;
      }
      printSection(`Approved ${id}`);
      console.log(`Executed as ${outcome.execution?.executionId}. Mock result:`);
      console.log(prettyJson(outcome.execution?.result));
      break;
    }

    case "reject": {
      const id = requireId(positionals, "reject");
      const reason = flags.reason ?? "";
      const record = rejectApproval(paths, id, reason);
      printSection(`Rejected ${id}`);
      console.log(`Reason: ${record.decisionReason}`);
      console.log("The tool was not executed and cannot be approved.");
      break;
    }

    case "audit": {
      const events = loadAudit(paths);
      printSection("Audit log");
      if (events.length === 0) {
        console.log("No audit events yet.");
        break;
      }
      for (const event of events) {
        const suffix = [
          event.approvalId ? `approval=${event.approvalId}` : "",
          event.toolName ? `tool=${event.toolName}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        console.log(`- ${event.timestamp}  ${event.event}${suffix ? `  (${suffix})` : ""}`);
      }
      break;
    }

    case "reset": {
      resetDemo(paths);
      printSection("Reset");
      console.log("Cleared approvals, executions, and the audit log to a clean demo state.");
      break;
    }

    default:
      console.error(
        `Unknown command: ${command ?? "(none)"}\n` +
          "Available: list, edit, approve, reject, audit, reset."
      );
      process.exitCode = 1;
  }
}

// Only run the CLI when this file is executed directly (via `tsx cli.ts ...`),
// not when it's imported — e.g. by the test suite, which imports
// `resolveExpectedHash` for a direct unit test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`\nError: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
