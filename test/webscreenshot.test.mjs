import test from "node:test";
import assert from "node:assert/strict";
import { buildScreenshotToolResult, capturePublicPage, takeScreenshotSlot } from "../webscreenshot.ts";

test("webscreenshot sends the key only as a Bearer header and returns a PNG attachment", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LATCHSHOT_API_KEY;
  process.env.LATCHSHOT_API_KEY = "ls_live_test_only";

  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "x-latchshot-render-ms": "412",
        "x-quota-remaining": "99",
      },
    });
  };

  try {
    const params = { url: "https://example.com/path?keep=yes", width: 800, height: 450, fullPage: true, timeout: 12 };
    const capture = await capturePublicPage(params);
    const result = buildScreenshotToolResult(params, capture);

    const endpoint = new URL(request.url);
    assert.equal(endpoint.origin + endpoint.pathname, "https://latchshot.fly.dev/v1/screenshot");
    assert.equal(endpoint.searchParams.get("url"), "https://example.com/path?keep=yes");
    assert.equal(endpoint.searchParams.get("width"), "800");
    assert.equal(endpoint.searchParams.get("height"), "450");
    assert.equal(endpoint.searchParams.get("fullPage"), "true");
    assert.equal(endpoint.searchParams.get("timeout"), "12000");
    assert.equal(endpoint.searchParams.get("format"), "png");
    assert.equal(request.init.headers.Authorization, "Bearer ls_live_test_only");
    assert.doesNotMatch(request.url, /ls_live_test_only/);
    assert.equal(result.attachments[0].mime, "image/png");
    assert.equal(result.attachments[0].url, "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(result.details.renderMs, "412");
    assert.equal(result.details.quotaRemaining, "99");
    assert.doesNotMatch(JSON.stringify(result), /ls_live_test_only/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LATCHSHOT_API_KEY;
    else process.env.LATCHSHOT_API_KEY = originalKey;
  }
});

test("webscreenshot fails clearly without a key and rejects non-public URL forms", async () => {
  const originalKey = process.env.LATCHSHOT_API_KEY;
  delete process.env.LATCHSHOT_API_KEY;
  try {
    await assert.rejects(
      capturePublicPage({ url: "https://example.com" }),
      /LATCHSHOT_API_KEY is required/,
    );
    process.env.LATCHSHOT_API_KEY = "ls_live_test_only";
    await assert.rejects(
      capturePublicPage({ url: "file:\/\/\/etc\/passwd" }),
      /public http:\/\/ or https:\/\//,
    );
    await assert.rejects(
      capturePublicPage({ url: "https://user:password@example.com/" }),
      /URL credentials are not supported/,
    );
  } finally {
    if (originalKey === undefined) delete process.env.LATCHSHOT_API_KEY;
    else process.env.LATCHSHOT_API_KEY = originalKey;
  }
});

test("webscreenshot enforces the ten-attempt session bound", () => {
  const counts = new Map();
  for (let index = 0; index < 10; index += 1) {
    takeScreenshotSlot(counts, "bounded-session", 10);
  }
  assert.throws(() => takeScreenshotSlot(counts, "bounded-session", 10), /limited to 10 captures per session/);
});
