import "dotenv/config";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

import type { Agent, AgentTask, AgentTurn, ToolObservation } from "./agent.js";
import { DEFAULT_MODEL, MAX_TOKENS, TEMPERATURE } from "./config.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./promptBuilder.js";

// OPTIONAL real-model adapter. Only `npm run demo:live` loads this file; the
// offline demos and the test suite never construct an OpenAI client.
//
// The model receives the real system prompt, the user's request, and — via the
// readWebPage tool result — the actual untrusted page text. It is free to
// propose any of the three tools, including sendReport. Whatever it proposes
// goes through exactly the same executor as the scripted agent.
//
// Results vary between runs and models. The model may well ignore the
// injection. That is a valid outcome, and the CLI reports it as such.

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "Live mode needs OPENAI_API_KEY. Copy .env.example to .env and add a key. " +
        "The offline demos (npm start, demo:normal, demo:unsafe, demo:protected) need no key."
    );
    this.name = "MissingApiKeyError";
  }
}

// The tool definitions the model sees. sendReport is listed on purpose: a
// realistic agent carries tools that most individual requests should not use.
const OPENAI_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "readWebPage",
      description: "Fetch a webpage and return its readable text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL of the page." } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submitSummary",
      description: "Deliver the final summary to the user. Call exactly once when finished.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sendReport",
      description: "Send an internal customer report to a recipient. Privileged business operation.",
      parameters: {
        type: "object",
        properties: {
          reportId: { type: "string", description: 'Report identifier, e.g. "DEMO-REPORT-001".' },
          recipient: { type: "string", description: "Recipient email address." },
        },
        required: ["reportId", "recipient"],
        additionalProperties: false,
      },
    },
  },
];

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Hand the raw string through: the executor rejects it as malformed
    // instead of this adapter guessing what the model meant.
    return raw;
  }
}

export function createLiveModelAgent(
  task: AgentTask,
  options: { apiKey?: string; model?: string } = {}
): Agent {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const model = options.model ?? (process.env.OPENAI_MODEL || DEFAULT_MODEL);
  const client = new OpenAI({ apiKey });
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(task) },
  ];

  return {
    kind: "live-model",
    label: `Live model (${model}) — real, non-deterministic output`,

    async nextTurn(): Promise<AgentTurn> {
      const response = await client.chat.completions.create({
        model,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        messages,
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
      });

      const message = response.choices[0].message;
      const toolCalls = (message.tool_calls ?? []).filter((call) => call.type === "function");
      messages.push({
        role: "assistant",
        content: message.content,
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      });

      return {
        toolCalls: toolCalls.map((call) => ({
          callId: call.id,
          proposal: { toolName: call.function.name, arguments: parseArguments(call.function.arguments) },
        })),
        ...(message.content ? { text: message.content } : {}),
      };
    },

    observe(observations: ToolObservation[]): void {
      for (const observation of observations) {
        messages.push({ role: "tool", tool_call_id: observation.callId, content: observation.content });
      }
    },
  };
}
