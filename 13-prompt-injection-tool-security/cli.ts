import { isPageVariant, PAGE_VARIANTS, loadExternalPage, type PageVariant } from "./pageLoader.js";
import { SYSTEM_PROMPT, buildUserMessage, wrapUntrustedContent } from "./promptBuilder.js";
import { printAudit, printLiveFindings, printScenario } from "./report.js";
import { createDemoSummaryRequest } from "./requestContext.js";
import { runScenario, type ExecutionMode } from "./runner.js";
import { blockNetworkAccess, printBanner, printSection } from "./utils.js";

// Individual scenarios, one npm script each:
//
//   npm run demo:normal                       normal page, protected
//   npm run demo:unsafe                       injected page, UNSAFE executor
//   npm run demo:protected                    injected page, protected
//   npm run demo:protected -- --page role-spoofing
//   npm run demo:prompt                       print the exact prompt a model would receive
//   npm run demo:live                         OPTIONAL real model, protected executor
//   npm run demo:live -- --unsafe             OPTIONAL real model, unsafe executor (mock effects only)
//
// Every command except demo:live runs with network access disabled.

function parseFlags(args: string[]): { page?: PageVariant; unsafe: boolean } {
  let page: PageVariant | undefined;
  let unsafe = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--unsafe") unsafe = true;
    else if (args[i] === "--page") {
      const value = args[++i] ?? "";
      if (!isPageVariant(value)) throw new Error(`--page must be one of: ${PAGE_VARIANTS.join(", ")}.`);
      page = value;
    } else {
      throw new Error(`Unknown option "${args[i]}".`);
    }
  }
  return { page, unsafe };
}

async function runOffline(title: string, mode: ExecutionMode, page: PageVariant): Promise<void> {
  blockNetworkAccess();
  console.log("AI Agents From Scratch — 13 Prompt Injection & Tool Security");
  console.log("Offline deterministic mode — the agent is SCRIPTED (simulated), not an LLM.");
  printBanner(title);
  const result = await runScenario({ mode, pageVariant: page });
  printScenario(result);
  printAudit(result.audit);
}

async function runLive(page: PageVariant, unsafe: boolean): Promise<void> {
  console.log("AI Agents From Scratch — 13 Prompt Injection & Tool Security");
  printBanner(`Live model — ${page} page, ${unsafe ? "UNSAFE" : "protected"} executor`);
  console.log(
    "This mode calls the OpenAI API. It needs OPENAI_API_KEY and will incur (small) API usage costs." +
      "\nThe model's behaviour is real and varies between runs. Tool side effects remain mock-only:" +
      "\nsendReport can only append to an in-memory array, and only for reserved example addresses."
  );

  // Loaded lazily so the offline demos and tests never import the OpenAI SDK.
  const { createLiveModelAgent } = await import("./liveAgent.js");
  const result = await runScenario({
    mode: unsafe ? "unsafe" : "protected",
    pageVariant: page,
    createAgent: (task) => createLiveModelAgent(task),
  });
  printScenario(result);
  printAudit(result.audit);
  printLiveFindings(result);
}

function printPrompt(page: PageVariant): void {
  const request = createDemoSummaryRequest();
  if (request.taskType !== "summarize_webpage") return;
  const content = loadExternalPage(page, request.targetUrl);

  printSection("System message (trusted application instructions)");
  console.log(SYSTEM_PROMPT);
  printSection("User message (trusted user request)");
  console.log(buildUserMessage(request));
  printSection(`Tool result for readWebPage (UNTRUSTED — ${page} page)`);
  console.log(wrapUntrustedContent(content));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case "normal":
      return runOffline("Demo A — Normal webpage", "protected", flags.page ?? "normal");
    case "unsafe":
      return runOffline("Demo B — Vulnerable agent (unsafe executor)", "unsafe", flags.page ?? "injected");
    case "protected":
      return runOffline("Demo C — Protected agent (policy-enforced executor)", "protected", flags.page ?? "injected");
    case "prompt":
      blockNetworkAccess();
      return printPrompt(flags.page ?? "injected");
    case "live":
      return runLive(flags.page ?? "injected", flags.unsafe);
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}. Available: normal, unsafe, protected, prompt, live.`);
  }
}

main().catch((error) => {
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
});
