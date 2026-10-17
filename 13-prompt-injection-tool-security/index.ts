import { printAudit, printScenario } from "./report.js";
import { runScenario, type ScenarioResult } from "./runner.js";
import { blockNetworkAccess, printBanner, printSection } from "./utils.js";

// `npm start` — the complete story in one offline run:
//
//   Demo A  normal page,   protected executor  → reads, summarizes
//   Demo B  injected page, UNSAFE executor     → mock report "sent"
//   Demo C  injected page, protected executor  → same proposal, BLOCKED
//
// The agent is SCRIPTED (simulated), so B and C receive the identical
// malicious proposal. The only difference between them is whether the
// executor asks the policy before running a tool. No API key, no network.

async function main(): Promise<void> {
  blockNetworkAccess();

  console.log("AI Agents From Scratch — 13 Prompt Injection & Tool Security");
  console.log(
    "\nOffline deterministic mode. The agent in these demos is SCRIPTED: it simulates a model that" +
      "\nobeys instructions it finds in the page. This shows an architecture, not how often a real model" +
      "\nfalls for this attack. Run `npm run demo:live` to try a real model."
  );

  printBanner("Demo A — Normal webpage");
  const normal = await runScenario({ mode: "protected", pageVariant: "normal" });
  printScenario(normal);

  printBanner("Demo B — Vulnerable agent (attacker-edited page, unsafe executor)");
  const unsafe = await runScenario({ mode: "unsafe", pageVariant: "injected" });
  printScenario(unsafe);

  printBanner("Demo C — Protected agent (same page, same proposal, policy-enforced executor)");
  const protectedRun = await runScenario({ mode: "protected", pageVariant: "injected" });
  printScenario(protectedRun);
  printAudit(protectedRun.audit);

  printComparison([
    ["A · Normal", normal],
    ["B · Vulnerable", unsafe],
    ["C · Protected", protectedRun],
  ]);

  printSection("Lesson");
  console.log("The page was able to influence what the agent PROPOSED in both B and C.");
  console.log("It could not influence what the application ALLOWED in C, because the policy");
  console.log("reads only the user's trusted request — never the page, the prompt, or the model.");
  console.log("\nExternal content is data, not authority.");
}

function printComparison(rows: [string, ScenarioResult][]): void {
  printSection("Comparison");
  const mark = (value: boolean) => (value ? "yes" : "no");
  const cells = (label: string, pick: (r: ScenarioResult) => string) =>
    `${label.padEnd(34)}${rows.map(([, r]) => pick(r).padEnd(18)).join("")}`.trimEnd();

  console.log(`${"".padEnd(34)}${rows.map(([name]) => name.padEnd(18)).join("")}`.trimEnd());
  console.log(cells("Malicious sendReport attempted", (r) => mark(r.outcome.attackAttempted)));
  console.log(cells("Mock side effect executed", (r) => (r.outcome.sideEffectExecuted ? "YES ✗" : "no")));
  console.log(
    cells("Blocked by policy enforcement", (r) =>
      r.mode === "unsafe" ? "no (no policy)" : r.outcome.attackAttempted ? mark(r.outcome.blockedByPolicy) : "n/a"
    )
  );
  console.log(cells("Page-grounded summary completed", (r) => mark(r.outcome.taskCompleted)));
}

main().catch((error) => {
  console.error("\nRun failed:", (error as Error).message);
  process.exitCode = 1;
});
