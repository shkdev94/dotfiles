const openai = { providerID: "openai" };

function withWebSearch(body) {
  const tools = body.tools ?? [];
  if (!tools.some((tool) => tool.type === "web_search")) {
    body.tools = [...tools, { type: "web_search" }];
  }
  return body;
}

function isOpenAIResponses(request) {
  const url = new URL(request.url);
  return (
    request.method === "POST" &&
    url.protocol === "https:" &&
    ((url.hostname === "api.openai.com" && url.pathname === "/v1/responses") ||
      (url.hostname === "chatgpt.com" &&
        url.pathname === "/backend-api/codex/responses"))
  );
}

export default {
  id: "dotfiles.openai-web-search",
  async setup(ctx) {
    // Hosted tools are added after OpenCode builds its local function tools.
    await ctx.session.hook(
      "http.request",
      async (event) => {
        if (event.kind !== "primary" || !isOpenAIResponses(event.request)) return;
        const body = withWebSearch(await event.request.clone().json());
        event.request = new Request(event.request, {
          body: JSON.stringify(body),
        });
      },
      openai,
    );

    // Responses over WebSocket do not pass through the HTTP request hook.
    await ctx.session.hook(
      "experimental.ws.send",
      (event) => {
        if (event.kind !== "primary") return;
        const body = JSON.parse(event.frame);
        if (body.type !== "response.create") return;
        event.frame = JSON.stringify(withWebSearch(body));
      },
      openai,
    );
  },
};
