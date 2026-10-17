import { DEMO_PAGE_URL, DEMO_USER_REQUEST } from "./config.js";
import { TrustedRequestSchema, type TrustedRequest } from "./types.js";
import { deepFreeze } from "./utils.js";

// The trusted side of the trust boundary.
//
// A TrustedRequest is built from what the USER asked for — the text they
// typed and the page they pointed at, as captured by the application's own UI
// or API. It is created before any external content is loaded, validated
// strictly, and frozen. No function in this module takes webpage content as an
// input, so there is no code path by which a page can reclassify the task or
// widen its scope.

/** Validate and freeze a trusted request. Throws on any unexpected field. */
export function createTrustedRequest(input: unknown): TrustedRequest {
  return deepFreeze(TrustedRequestSchema.parse(input));
}

/** The demo's request: "summarize this page", scoped to one URL. */
export function createDemoSummaryRequest(): TrustedRequest {
  return createTrustedRequest({
    requestId: "REQ-001",
    taskType: "summarize_webpage",
    userRequest: DEMO_USER_REQUEST,
    targetUrl: DEMO_PAGE_URL,
  });
}
