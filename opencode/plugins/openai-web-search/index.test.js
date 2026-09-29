import assert from "node:assert/strict";
import test from "node:test";
import plugin from "./index.js";

async function hooks() {
  const registered = new Map();
  await plugin.setup({
    session: {
      async hook(name, callback, scope) {
        assert.equal(scope.providerID, "openai");
        registered.set(name, callback);
      },
    },
  });
  return registered;
}

function request(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test": "preserved" },
    body: JSON.stringify(body),
  });
}

test("adds hosted search to API and Codex requests while preserving local tools", async () => {
  const hook = (await hooks()).get("http.request");
  const local = { type: "function", name: "read", parameters: { type: "object" } };
  for (const url of [
    "https://api.openai.com/v1/responses",
    "https://chatgpt.com/backend-api/codex/responses",
  ]) {
    const event = {
      kind: "primary",
      request: request(url, { model: "gpt-6-sol", tools: [local], tool_choice: "auto" }),
    };

    await hook(event);

    assert.deepEqual(await event.request.json(), {
      model: "gpt-6-sol",
      tools: [local, { type: "web_search" }],
      tool_choice: "auto",
    });
    assert.equal(event.request.headers.get("X-Test"), "preserved");
  }
});

test("preserves existing hosted search options without adding a duplicate", async () => {
  const hook = (await hooks()).get("http.request");
  const body = { tools: [{ type: "web_search", search_context_size: "low" }] };
  const event = { kind: "primary", request: request("https://api.openai.com/v1/responses", body) };

  await hook(event);

  assert.deepEqual(await event.request.json(), body);
});

test("leaves auxiliary and unrelated HTTP requests untouched", async () => {
  const hook = (await hooks()).get("http.request");
  for (const [kind, url] of [
    ["compaction", "https://api.openai.com/v1/responses"],
    ["title", "https://api.openai.com/v1/responses"],
    ["generate", "https://api.openai.com/v1/responses"],
    ["primary", "https://api.openai.com/v1/chat/completions"],
    ["primary", "https://proxy.example.com/v1/responses"],
  ]) {
    const original = request(url, { tools: [] });
    const event = { kind, request: original };

    await hook(event);

    assert.equal(event.request, original);
    assert.equal(event.request.bodyUsed, false);
  }
});

test("adds hosted search to WebSocket create frames and preserves existing tools", async () => {
  const hook = (await hooks()).get("experimental.ws.send");
  const tool = { type: "function", name: "read" };
  const event = {
    kind: "primary",
    frame: JSON.stringify({ type: "response.create", tools: [tool] }),
  };

  hook(event);
  hook(event);

  assert.deepEqual(JSON.parse(event.frame), {
    type: "response.create",
    tools: [tool, { type: "web_search" }],
  });
});

test("leaves auxiliary and non-create WebSocket frames unchanged", async () => {
  const hook = (await hooks()).get("experimental.ws.send");
  for (const [kind, type] of [["compaction", "response.create"], ["primary", "response.cancel"]]) {
    const frame = JSON.stringify({ type });
    const event = { kind, frame };

    hook(event);

    assert.equal(event.frame, frame);
  }
});
