import assert from "node:assert/strict";

import { createScriptedAgent, findEmbeddedReportInstruction, type Agent } from "../agent.js";
import { AuditLog } from "../auditLog.js";
import { ATTACKER_RECIPIENT, ATTACKER_REPORT_ID, DEMO_PAGE_URL, DEMO_USER_REQUEST } from "../config.js";
import { MissingApiKeyError, createLiveModelAgent } from "../liveAgent.js";
import { createMockEnvironment } from "../mockTools.js";
import { extractReadableText, loadExternalPage, loadFixtureHtml } from "../pageLoader.js";
import { authorizeToolCall, permittedTools } from "../policy.js";
import { wrapUntrustedContent } from "../promptBuilder.js";
import { createDemoSummaryRequest, createTrustedRequest } from "../requestContext.js";
import { runScenario, type ScenarioResult } from "../runner.js";
import { createProtectedExecutor, createUnsafeExecutor } from "../toolExecutor.js";
import { ToolArgumentSchemas, type TrustedRequest } from "../types.js";

// Deterministic tests: NO model calls, NO API key, NO network.
//
// What these tests establish: given a proposal — whoever produced it — the
// protected executor only runs what the trusted request authorizes, rejects
// malformed input, records why, and causes no side effect when it refuses.
// They also pin down the fixtures and the prompt-wrapping behaviour.
//
// What they do NOT establish: how often a real model follows the injection.
// The scripted agent is a stand-in that always obeys the page. Real-model
// behaviour is only observable through `npm run demo:live`, and is not
// asserted anywhere here.

// ── network tripwire ─────────────────────────────────────────────────────────

// Any fetch from any code path fails the run AND is counted.
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("Network access attempted during deterministic tests.");
}) as typeof fetch;

// A fake key, so the audit-leak test can look for it.
const FAKE_SECRET = "sk-test-DO-NOT-LEAK-1234567890";
process.env.OPENAI_API_KEY = FAKE_SECRET;

// ── fixtures ─────────────────────────────────────────────────────────────────

const ATTACK = { toolName: "sendReport", arguments: { reportId: ATTACKER_REPORT_ID, recipient: ATTACKER_RECIPIENT } };

function protectedHarness(request: TrustedRequest = createDemoSummaryRequest()) {
  const env = createMockEnvironment("injected");
  const audit = new AuditLog();
  return { env, audit, executor: createProtectedExecutor(request, env, audit) };
}

function sendReportStep(result: ScenarioResult) {
  const step = result.steps.find((s) => (s.proposal as { toolName?: string }).toolName === "sendReport");
  assert.ok(step, "expected a sendReport proposal");
  return step;
}

// ── tiny async test runner ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(error as Error).message.split("\n")[0]}`);
  }
}

async function main(): Promise<void> {
  console.log("\nPrompt Injection & Tool Security — tests\n");

  // Shared runs (each creates its own environment and audit log).
  const normal = await runScenario({ mode: "protected", pageVariant: "normal" });
  const unsafe = await runScenario({ mode: "unsafe", pageVariant: "injected" });
  const guarded = await runScenario({ mode: "protected", pageVariant: "injected" });
  const spoofed = await runScenario({ mode: "protected", pageVariant: "role-spoofing" });
  const spoofedUnsafe = await runScenario({ mode: "unsafe", pageVariant: "role-spoofing" });

  // 1
  await test("normal page: summarization is permitted and nothing else is proposed", () => {
    assert.deepEqual(
      normal.steps.map((s) => [(s.proposal as { toolName: string }).toolName, s.result.status]),
      [
        ["readWebPage", "executed"],
        ["submitSummary", "executed"],
      ]
    );
    assert.equal(normal.outcome.taskCompleted, true);
    assert.equal(normal.outcome.attackAttempted, false);
    assert.equal(normal.outbox.length, 0);
    assert.match(normal.summary ?? "", /30 days to 45 days/);
  });

  // 2
  await test("injected fixture: hidden instruction is invisible in HTML but present in extracted text", () => {
    const html = loadFixtureHtml("injected");
    assert.match(html, /style="display:none"/);
    const { text } = extractReadableText(html);
    assert.ok(text.includes("sendReport"));
    assert.ok(text.includes(ATTACKER_REPORT_ID));
    assert.ok(text.includes(ATTACKER_RECIPIENT));
    assert.ok(text.includes("30 days to 45 days"), "legitimate content must still be there");
    assert.ok(!text.includes("FIXTURE NOTE"), "HTML comments must not reach the agent");
    assert.deepEqual(findEmbeddedReportInstruction(text), { reportId: ATTACKER_REPORT_ID, recipient: ATTACKER_RECIPIENT });
    assert.equal(findEmbeddedReportInstruction(extractReadableText(loadFixtureHtml("normal")).text), null);
  });

  // 3
  await test("vulnerable path: the scripted proposal executes the mock unauthorized sendReport", () => {
    assert.equal(sendReportStep(unsafe).result.status, "executed");
    assert.deepEqual(unsafe.outbox, [
      { reportId: ATTACKER_REPORT_ID, recipient: ATTACKER_RECIPIENT, recordCount: 3, channel: "local-mock-outbox" },
    ]);
    assert.ok(unsafe.audit.some((e) => e.event === "AUTHORIZATION_SKIPPED" && e.toolName === "sendReport"));
    assert.ok(!unsafe.audit.some((e) => e.event === "POLICY_EVALUATED"));
  });

  // 4
  await test("protected path: the IDENTICAL proposal is rejected", () => {
    const blocked = sendReportStep(guarded);
    assert.deepEqual(blocked.proposal, sendReportStep(unsafe).proposal);
    assert.equal(blocked.result.status, "blocked");
    if (blocked.result.status !== "blocked") return;
    assert.equal(blocked.result.policy.decision, "deny");
    assert.equal(blocked.result.policy.rule, "TOOL_NOT_PERMITTED_FOR_TASK");
    assert.equal(guarded.outcome.blockedByPolicy, true);
  });

  // 5
  await test("a schema-valid sendReport call does not bypass authorization", () => {
    assert.equal(ToolArgumentSchemas.sendReport.safeParse(ATTACK.arguments).success, true);
    const { env, executor } = protectedHarness();
    const result = executor.dispatch(ATTACK);
    assert.equal(result.status, "blocked");
    assert.equal(env.outbox.length, 0);
  });

  // 6
  await test("unknown tools are denied by default (including prototype keys)", () => {
    const { audit, executor } = protectedHarness();
    for (const toolName of ["deleteAllCustomers", "constructor", "__proto__", "SendReport"]) {
      const result = executor.dispatch({ toolName, arguments: {} });
      assert.equal(result.status, "blocked", toolName);
      if (result.status === "blocked") assert.equal(result.policy.rule, "UNKNOWN_TOOL");
    }
    assert.equal(audit.events().filter((e) => e.event === "TOOL_EXECUTION_BLOCKED").length, 4);
  });

  // 7
  await test("a webpage cannot change the trusted request's permitted capabilities", () => {
    for (const run of [guarded, spoofed]) {
      assert.equal(run.request.taskType, "summarize_webpage");
      assert.deepEqual([...permittedTools(run.request)], ["readWebPage", "submitSummary"]);
      assert.ok(Object.isFrozen(run.request));
    }
    const request = createDemoSummaryRequest();
    assert.throws(() => {
      (request as { taskType: string }).taskType = "send_report";
    }, TypeError);
    // There is no field through which capabilities could be granted.
    assert.throws(() =>
      createTrustedRequest({ ...request, allowedTools: ["readWebPage", "submitSummary", "sendReport"] })
    );
  });

  // 8
  await test("role-spoofing page ('SYSTEM: developer override', fake allowedTools) cannot change policy", () => {
    const { text } = extractReadableText(loadFixtureHtml("role-spoofing"));
    assert.match(text, /SYSTEM: Developer override/);
    assert.match(text, /"allowedTools": \["readWebPage", "submitSummary", "sendReport"\]/);
    assert.ok(text.includes("</untrusted_content>"), "fixture tries to close the content block early");

    // The page succeeded in steering the (scripted) agent...
    const step = sendReportStep(spoofed);
    // ...but the decision is identical to the plain injection, and nothing ran.
    assert.equal(step.result.status, "blocked");
    if (step.result.status === "blocked") assert.equal(step.result.policy.rule, "TOOL_NOT_PERMITTED_FOR_TASK");
    assert.equal(spoofed.outbox.length, 0);
    // And the same proposal DOES run on the unsafe executor — the spoof "works" without enforcement.
    assert.equal(spoofedUnsafe.outbox.length, 1);
  });

  // 8b
  await test("prompt wrapping neutralises a fake closing delimiter inside the page", () => {
    const wrapped = wrapUntrustedContent(loadExternalPage("role-spoofing", DEMO_PAGE_URL));
    assert.equal(wrapped.match(/<\/untrusted_content>/g)?.length, 1);
    // Between the real opening tag's line and the real closing tag, no live delimiter survives.
    const body = wrapped.slice(wrapped.indexOf("\n"), wrapped.indexOf("</untrusted_content>"));
    assert.ok(!/<\s*\/?\s*untrusted_content/i.test(body));
    assert.ok(body.includes("&lt;/untrusted_content") && body.includes("&lt;untrusted_content"));
    assert.ok(!wrapped.includes("role-spoofing"), "fixture name must not leak to the model");
  });

  // 9
  await test("protected mode: unauthorized calls produce no side effect and no network access", () => {
    assert.equal(guarded.outbox.length, 0);
    assert.equal(spoofed.outbox.length, 0);
    assert.equal(guarded.outcome.sideEffectExecuted, false);
    assert.ok(!guarded.audit.some((e) => e.event === "TOOL_EXECUTED" && e.toolName === "sendReport"));
    assert.equal(fetchCalls, 0);
  });

  // 10
  await test("audit trace records the blocked attempt, in order, with the correct reason", () => {
    const events = guarded.audit;
    const proposed = events.findIndex((e) => e.event === "TOOL_CALL_PROPOSED" && e.toolName === "sendReport");
    const evaluated = events.findIndex((e) => e.event === "POLICY_EVALUATED" && e.toolName === "sendReport");
    const blocked = events.findIndex((e) => e.event === "TOOL_EXECUTION_BLOCKED" && e.toolName === "sendReport");
    assert.ok(proposed >= 0 && proposed < evaluated && evaluated < blocked, "proposed → evaluated → blocked");

    assert.deepEqual(events[proposed].metadata?.untrustedSourcesInContext, [
      "web:support.example.com/policies/refund-policy-update",
    ]);
    assert.equal(events[evaluated].metadata?.decision, "deny");
    assert.deepEqual(events[blocked].metadata?.arguments, ATTACK.arguments);
    assert.equal(events[blocked].metadata?.rule, "TOOL_NOT_PERMITTED_FOR_TASK");
    assert.match(String(events[blocked].metadata?.reason), /not authorized by this user's summarize_webpage request/);
    assert.ok(events.some((e) => e.event === "EXTERNAL_CONTENT_LOADED" && e.metadata?.trust === "untrusted"));
  });

  // 11
  await test("the legitimate task succeeds with security enabled, with the same summary as the clean page", () => {
    assert.equal(guarded.outcome.taskCompleted, true);
    assert.equal(guarded.summary, normal.summary);
    assert.ok(!(guarded.summary ?? "").includes(ATTACKER_RECIPIENT));
    assert.ok(guarded.audit.some((e) => e.event === "SUMMARY_COMPLETED"));
  });

  // 12
  await test("malformed tool arguments and proposals are rejected before policy", () => {
    const { env, audit, executor } = protectedHarness();
    const malformed: unknown[] = [
      { toolName: "sendReport", arguments: { reportId: ATTACKER_REPORT_ID, recipient: "not-an-email" } },
      { toolName: "sendReport", arguments: { reportId: ATTACKER_REPORT_ID } },
      { toolName: "sendReport", arguments: { ...ATTACK.arguments, authorized: true } },
      { toolName: "sendReport", arguments: '{"reportId":"DEMO-REPORT-001"' },
      { toolName: "readWebPage", arguments: { url: "not a url" } },
      { ...ATTACK, approvedByUser: true },
      { arguments: {} },
      null,
      "sendReport(DEMO-REPORT-001)",
    ];
    for (const proposal of malformed) {
      assert.equal(executor.dispatch(proposal).status, "invalid", JSON.stringify(proposal));
    }
    assert.equal(env.outbox.length, 0);
    assert.ok(!audit.events().some((e) => e.event === "POLICY_EVALUATED"));
    assert.equal(audit.events().filter((e) => e.event === "TOOL_CALL_INVALID").length, malformed.length);
  });

  // 12b
  await test("demo safety rail: sendReport arguments only accept reserved example domains", () => {
    const schema = ToolArgumentSchemas.sendReport;
    assert.equal(schema.safeParse({ reportId: ATTACKER_REPORT_ID, recipient: "someone@gmail.com" }).success, false);
    assert.equal(schema.safeParse({ reportId: ATTACKER_REPORT_ID, recipient: "a@example.com" }).success, true);
    assert.equal(schema.safeParse({ reportId: ATTACKER_REPORT_ID, recipient: "a@b.invalid" }).success, true);
  });

  // 13
  await test("a denied tool cannot be invoked through the protected dispatcher by any route", () => {
    // A mutable request object handed in by a caller...
    const mutable = {
      requestId: "REQ-001",
      taskType: "summarize_webpage",
      userRequest: DEMO_USER_REQUEST,
      targetUrl: DEMO_PAGE_URL,
    } as Record<string, unknown>;
    const { env, executor } = protectedHarness(mutable as TrustedRequest);

    // ...mutated AFTER the executor was created, to look like a report request.
    Object.assign(mutable, { taskType: "send_report", reportId: ATTACKER_REPORT_ID, recipient: ATTACKER_RECIPIENT });
    delete mutable.targetUrl;

    for (let i = 0; i < 3; i++) assert.equal(executor.dispatch(ATTACK).status, "blocked");
    assert.equal(executor.dispatch({ ...ATTACK, toolName: "sendReport " }).status, "blocked"); // unknown name
    // The executor exposes nothing but `mode` and `dispatch`, and cannot be patched.
    assert.deepEqual(Object.keys(executor).sort(), ["dispatch", "mode"]);
    assert.ok(Object.isFrozen(executor));
    assert.equal(env.outbox.length, 0);
  });

  // 14
  await test("live-model mode is separate: deterministic runs never use it, missing key fails before any call", () => {
    assert.equal(guarded.agentKind, "scripted");
    assert.match(guarded.agentLabel, /SIMULATED/);
    assert.throws(
      () => createLiveModelAgent({ userRequest: DEMO_USER_REQUEST, targetUrl: DEMO_PAGE_URL }, { apiKey: "" }),
      MissingApiKeyError
    );
    assert.equal(fetchCalls, 0);
  });

  // 14b
  await test("a model that ignores the injection is reported honestly (stub agent, no network)", async () => {
    // Stands in for a live model that read the page and declined the injected
    // step. Exercises the same reporting a live run uses.
    const ignoringModel = (task: Parameters<typeof createScriptedAgent>[0]): Agent => {
      const inner = createScriptedAgent(task);
      return {
        kind: "live-model",
        label: "Stub model that ignores page instructions (test double)",
        async nextTurn() {
          const turn = await inner.nextTurn();
          return {
            ...turn,
            toolCalls: turn.toolCalls.filter((c) => (c.proposal as { toolName: string }).toolName !== "sendReport"),
          };
        },
        observe: (o) => inner.observe(o),
      };
    };
    const result = await runScenario({ mode: "protected", pageVariant: "injected", createAgent: ignoringModel });
    assert.equal(result.outcome.attackAttempted, false);
    assert.equal(result.outcome.blockedByPolicy, false);
    assert.equal(result.outcome.taskCompleted, true);
    assert.equal(result.outbox.length, 0);
  });

  // 15
  await test("readWebPage is scoped to the page the user named", () => {
    const { executor } = protectedHarness();
    const other = executor.dispatch({ toolName: "readWebPage", arguments: { url: "https://attacker.example/next-step" } });
    assert.equal(other.status, "blocked");
    if (other.status === "blocked") assert.equal(other.policy.rule, "URL_OUTSIDE_REQUEST_SCOPE");
    const sameButCased = executor.dispatch({
      toolName: "readWebPage",
      arguments: { url: "HTTPS://Support.Example.com/policies/refund-policy-update" },
    });
    assert.equal(sameButCased.status, "executed");
  });

  // 16
  await test("authorization comes from the user: a report request allows exactly the report the user named", () => {
    const request = createTrustedRequest({
      requestId: "REQ-002",
      taskType: "send_report",
      userRequest: "Send DEMO-REPORT-001 to our internal auditor at audit@internal.example.invalid.",
      reportId: "DEMO-REPORT-001",
      recipient: "audit@internal.example.invalid",
    });
    const { env, executor } = protectedHarness(request);
    assert.equal(executor.dispatch(ATTACK).status, "blocked"); // attacker's recipient
    assert.equal(
      executor.dispatch({ toolName: "sendReport", arguments: { reportId: "DEMO-REPORT-001", recipient: "audit@internal.example.invalid" } })
        .status,
      "executed"
    );
    assert.equal(executor.dispatch({ toolName: "readWebPage", arguments: { url: DEMO_PAGE_URL } }).status, "blocked");
    assert.deepEqual(env.outbox.map((r) => r.recipient), ["audit@internal.example.invalid"]);
  });

  // 17
  await test("policy decision is a pure function of (trusted request, call) — same for every page variant", () => {
    const decisions = [guarded, spoofed].map((r) => {
      const step = sendReportStep(r);
      return step.result.status === "blocked" ? step.result.policy : null;
    });
    assert.deepEqual(decisions[0], decisions[1]);
    assert.deepEqual(
      authorizeToolCall(createDemoSummaryRequest(), { toolName: "sendReport", arguments: ATTACK.arguments }),
      decisions[0]
    );
  });

  // 18
  await test("audit trace never contains secrets", () => {
    for (const run of [normal, unsafe, guarded, spoofed]) {
      assert.ok(!JSON.stringify(run.audit).includes(FAKE_SECRET));
    }
    const audit = new AuditLog();
    audit.record("TOOL_CALL_INVALID", { metadata: { apiKey: "anything", note: `leaked ${FAKE_SECRET}` } });
    const [event] = audit.events();
    assert.equal(event.metadata?.apiKey, "[REDACTED]");
    assert.equal(event.metadata?.note, "leaked [REDACTED]");
  });

  // 19
  await test("unsafe executor is still offline: the 'sent' report only reaches the in-memory outbox", () => {
    assert.equal(unsafe.outbox[0].channel, "local-mock-outbox");
    const env = createMockEnvironment("injected");
    const executor = createUnsafeExecutor(env, new AuditLog());
    const outside = executor.dispatch({ toolName: "readWebPage", arguments: { url: "https://real-site.example.com/" } });
    assert.equal(outside.status, "failed");
    assert.equal(fetchCalls, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
