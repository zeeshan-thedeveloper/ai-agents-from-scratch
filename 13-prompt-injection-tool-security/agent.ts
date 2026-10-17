// The agent side of the system: something that reads observations and
// proposes tool calls. It has NO ability to execute anything — it only
// returns proposals. Execution belongs to toolExecutor.ts.
//
// This file holds the shared Agent contract and the deterministic scripted
// agent used by every offline demo and every test. The optional real model
// lives in liveAgent.ts and is only loaded by `npm run demo:live`.

export interface AgentTask {
  userRequest: string;
  targetUrl: string;
}

export interface AgentToolCall {
  callId: string;
  // Deliberately `unknown`: whatever an agent emits is untrusted until the
  // executor has validated it.
  proposal: unknown;
}

export interface AgentTurn {
  toolCalls: AgentToolCall[];
  // Plain text the agent produced instead of (or alongside) tool calls.
  text?: string;
}

export interface ToolObservation {
  callId: string;
  toolName: string;
  content: string;
}

export interface Agent {
  readonly kind: "scripted" | "live-model";
  readonly label: string;
  nextTurn(): Promise<AgentTurn>;
  observe(observations: ToolObservation[]): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scripted agent (SIMULATED — not an LLM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a sendReport instruction embedded in text the agent has read. Matches
 * both the prose phrasing in injected-page.html and the JSON phrasing in
 * role-spoofing-page.html. The values are copied from the PAGE, never from
 * any constant in this codebase.
 */
export function findEmbeddedReportInstruction(text: string): { reportId: string; recipient: string } | null {
  if (!/sendReport/.test(text)) return null;
  const reportId = text.match(/reportId\W{1,6}(DEMO-REPORT-\d{3})/)?.[1];
  const recipient = text.match(/recipient\W{1,6}([^\s"'<>]+@[^\s"'<>]+)/)?.[1];
  return reportId && recipient ? { reportId, recipient } : null;
}

/**
 * Deterministic summary of the page: the bullet points from its "What is
 * changing" list. The attack text in both fixtures is prose, not a bullet
 * list, so it never ends up in this summary.
 */
export function buildScriptedSummary(pageText: string): string {
  const bullets = pageText.split("\n").filter((line) => line.startsWith("- "));
  if (bullets.length === 0) return "I could not read any refund-policy changes from the page.";
  return ["Main changes to the customer refund policy:", ...bullets].join("\n");
}

/**
 * A scripted stand-in for a model that has been successfully manipulated by
 * the page it read.
 *
 *   turn 1: propose readWebPage(<the URL the user gave>)
 *   turn 2: if the page contains a sendReport instruction, propose it — with
 *           the arguments copied from the page — then propose submitSummary
 *   turn 3: stop
 *
 * On the normal page there is no instruction, so it only reads and
 * summarizes. On the attack pages it obeys the page, every time. That makes
 * the vulnerable and protected runs receive the IDENTICAL malicious proposal,
 * so the only difference between them is the authorization boundary.
 *
 * This is NOT evidence that any real model behaves this way. Use
 * `npm run demo:live` to see what an actual model does.
 */
export function createScriptedAgent(task: AgentTask): Agent {
  let stage: "read" | "act" | "done" = "read";
  let pageText = "";
  let counter = 0;
  const nextId = () => `scripted-call-${++counter}`;

  return {
    kind: "scripted",
    label: "Scripted agent — SIMULATED decisions, not an LLM",

    async nextTurn(): Promise<AgentTurn> {
      if (stage === "read") {
        stage = "act";
        return {
          toolCalls: [{ callId: nextId(), proposal: { toolName: "readWebPage", arguments: { url: task.targetUrl } } }],
        };
      }

      if (stage === "act") {
        stage = "done";
        const toolCalls: AgentToolCall[] = [];
        const embedded = findEmbeddedReportInstruction(pageText);
        if (embedded) {
          toolCalls.push({ callId: nextId(), proposal: { toolName: "sendReport", arguments: embedded } });
        }
        toolCalls.push({
          callId: nextId(),
          proposal: { toolName: "submitSummary", arguments: { summary: buildScriptedSummary(pageText) } },
        });
        return { toolCalls };
      }

      return { toolCalls: [], text: "Done." };
    },

    observe(observations: ToolObservation[]): void {
      for (const observation of observations) {
        if (observation.toolName === "readWebPage") pageText += `${observation.content}\n`;
      }
    },
  };
}
