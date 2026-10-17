# AI Agents From Scratch

> Learn how AI agents actually work by building every core pattern from zero — no frameworks, just code and concepts.

This is a structured learning lab, not a library. Each folder is one self-contained pattern you can read, run, and copy in under five minutes.

---

## Start here

**New to LLM apps?**
Start with [`01-basics/simple-llm-call`](./01-basics/simple-llm-call/) — one API call, one response, no abstractions.

**Already comfortable with basic LLM calls?**
Jump to [`02-tool-use`](./02-tool-use/) — this is the first pattern where the model can call your backend functions before it answers. It's where "chat with an LLM" becomes something closer to an actual agent.

---

## Why this exists

Most agent tutorials either hide the complexity inside a framework, or throw you into production-grade code before you understand the fundamentals. This repo sits in the middle: real working code, minimal dependencies, maximum clarity.

AI Agents From Scratch is a learning lab where I document the core engineering patterns behind AI agents by building each concept from zero in TypeScript. No frameworks, no magic abstractions — just small, runnable examples that show how the pattern actually works.

Later, these same patterns can be combined into larger systems such as workflow builders, support assistants, research agents, or internal automation tools.

---

## Setup

**There is intentionally no root `package.json`.** Each folder is fully standalone — install and run from inside each one.

```bash
cd 02-tool-use
cp .env.example .env        # add your API key
npm install
npm start
```

You need:
- Node.js 18+
- an OpenAI API key (get one at [platform.openai.com](https://platform.openai.com))

Some examples require additional API keys. For example, `04-web-search` also needs a `TAVILY_API_KEY`. Each folder includes its own `.env.example` file showing exactly which variables are required.

---

## The series

This repo is the backbone of my **"AI Agents From Scratch"** LinkedIn series. Each folder = one post.

---

## Patterns

### 01 — Basics

| Pattern | What it demonstrates |
|---|---|
| [simple-llm-call](./01-basics/simple-llm-call/) | One API call, reading the response, understanding tokens |
| [prompt-chaining](./01-basics/prompt-chaining/) | Passing output of one call as input to the next |
| [structured-output](./01-basics/structured-output/) | Getting reliable JSON back from an LLM |
| [streaming](./01-basics/streaming/) | Handling partial response chunks as they arrive |
| [conversation-history](./01-basics/conversation-history/) | Maintaining multi-turn memory with a messages array |
| [system-vs-user-prompt](./01-basics/system-vs-user-prompt/) | Comparing system instructions with user prompts |
| [temperature-and-tokens](./01-basics/temperature-and-tokens/) | Seeing how temperature and token limits affect output |
| [prompt-templates](./01-basics/prompt-templates/) | Filling simple string templates with variables |
| [few-shot-prompting](./01-basics/few-shot-prompting/) | Providing examples in context instead of fine-tuning |
| [error-handling-retries](./01-basics/error-handling-retries/) | Retrying rate limits and transient failures safely |
| [input-output-validation](./01-basics/input-output-validation/) | Validating prompts and model output at the boundary |

### 02 — Tool Use

| Pattern | What it demonstrates |
|---|---|
| [tool-use](./02-tool-use/) | Function calling: LLM decides which of your functions to call, with what args, in a multi-round loop |

### 03 — Agent Loop

| Pattern | What it demonstrates |
|---|---|
| [agent-loop](./03-agent-loop/) | Goal-directed agent that decides its own next steps each iteration, with a MAX_ITERATIONS circuit breaker and terminal tool pattern |

### 04 — Web Search

| Pattern | What it demonstrates |
|---|---|
| [web-search](./04-web-search/) | Agent loop with a live web search tool: the model searches, reads results, decides whether to search again, and writes a sourced answer |

### 05 — Scrape Page

| Pattern | What it demonstrates |
|---|---|
| [scrape-page](./05-scrape-page/) | Research agent with search + selective page scraping: discover candidate URLs, open one page, extract readable text, and answer with source context |

### 06 — Memory

| Pattern | What it demonstrates |
|---|---|
| [memory](./06-memory/) | Four agent memory strategies: full buffer, sliding window, summary compression, and persistent facts across sessions |

### 07 — Reliability & Observability

| Pattern | What it demonstrates |
|---|---|
| [reliability-observability](./07-reliability-observability/) | Step-level traces, tool errors, retries, max iterations, and debugging visibility for agent loops |

### 08 — Evaluation

| Pattern | What it demonstrates |
|---|---|
| [evaluation](./08-evaluation/) | Eval harness for tool-calling agents: check final answers, tool selection, arguments, forbidden tools, iteration limits, grounding, and optional LLM judge feedback |

### 09 — Multi-Agent

| Pattern | What it demonstrates |
|---|---|
| [multi-agent](./09-multi-agent/) | Coordinating multiple specialized agents: planner, worker, and reviewer. Shows role boundaries, structured handoffs, shared context, and review before final output. |

### 10 — Routing

| Pattern | What it demonstrates |
|---|---|
| [routing](./10-routing/) | Router agent that chooses the smallest safe execution path: direct answer, tool use, research, multi-agent workflow, human approval, or refusal. |

### 11 — Human-in-the-Loop

| Pattern | What it demonstrates |
|---|---|
| [human-in-the-loop](./11-human-in-the-loop/) | An agent proposes a risky action, deterministic policy pauses it, a human approves, edits, or rejects it, and approved execution is revalidated, audited, and protected against duplicate runs. |

### 12 — Durable Execution

| Pattern | What it demonstrates |
|---|---|
| [durable-execution](./12-durable-execution/) | A checkpointed workflow survives a simulated crash, resumes from persisted state, and uses idempotency keys to avoid replaying side effects such as refunds. |

### 13 — Prompt Injection & Tool Security

| Pattern | What it demonstrates |
|---|---|
| [prompt-injection-tool-security](./13-prompt-injection-tool-security/) | An agent reads an attacker-controlled webpage containing malicious instructions. Compare vulnerable tool execution with an application-enforced security boundary that blocks unauthorized actions. |

*More patterns coming — workflow orchestration, workers, and concurrency control.*

---

## Usage note

This repo is for learning and educational reference. Examples use mock data where possible to keep things runnable without external dependencies.

Real applications built on these patterns also need: authentication, authorization, input validation, output sanitization, rate limiting, logging, monitoring, and infrastructure protections. None of that is in scope here — this is the concepts layer.

---

## License / Usage

No open-source license has been added yet.

This repository is currently shared for learning, reading, and portfolio demonstration purposes. Please do not reuse or redistribute the code as a package/library unless a license is added later.
