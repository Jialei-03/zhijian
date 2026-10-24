import { afterEach, expect, it, vi } from "vitest";
import {
  convertAgentDocument,
  importAgentDocument,
  addTeamMember,
  editTeamMember,
} from "../research/team-api";
import { documentDraft, memberDraft } from "./member-model";

afterEach(() => vi.unstubAllGlobals());
it("sends image data only with the member save and marks image-sized requests", async () => {
  vi.stubGlobal("document", { cookie: "" });
  const fetcher = vi.fn().mockImplementation(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  const upload = { extension: "png" as const, content: "image-base64" };
  await addTeamMember("w", {
    config: memberDraft({ name: "Ada" }),
    avatar_upload: upload,
  });
  expect(fetcher.mock.calls[0][1].headers.get("X-Avatar-Upload")).toBe("1");
  expect(JSON.parse(fetcher.mock.calls[0][1].body).avatar_upload).toEqual(
    upload,
  );
  await editTeamMember("w", "ada", {
    config: memberDraft({ name: "Ada", avatar: "pixel:new" }),
  });
  expect(fetcher.mock.calls[1][1].headers.has("X-Avatar-Upload")).toBe(false);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).config.avatar).toBe(
    "pixel:new",
  );
});
it("form → source → form sends the original document and keeps unknown fields", async () => {
  vi.stubGlobal("document", { cookie: "" });
  const source = "---\nname: Ada\nfuture: [keep]\n---\n\n# Original";
  const edited = source.replace("# Original", "# Edited");
  const draft = memberDraft({
    name: "Ada",
    role_description: "# Edited",
    wake_minutes: 9,
  });
  const response = {
    source: edited,
    config: { ...draft, channels: ["#综述"] },
    warnings: [],
  };
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(response), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const document = await convertAgentDocument("w", source, draft, ["#综述"]);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
    source,
    config: { role_description: "# Edited" },
    channels: ["#综述"],
  });
  expect(document.source).toContain("future: [keep]");
  const next = documentDraft(document, [{ id: "review", name: "综述" }]);
  expect(next.draft.role_description).toBe("# Edited");
  expect(next.subscriptions).toEqual(["review"]);
  await convertAgentDocument("w", edited);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ source: edited });
});
it("a malformed source keeps the draft and exposes the server's line number", async () => {
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ detail: "第 3 行 / Line 3: Invalid tools" }),
          { status: 422 },
        ),
      ),
  );
  const draft = memberDraft({ name: "Ada", role_description: "Last valid" });
  await expect(convertAgentDocument("w", "bad")).rejects.toThrow("Line 3");
  expect(draft.role_description).toBe("Last valid");
});
it("imports selected filenames and pasted Codex/Claude content through one API", async () => {
  vi.stubGlobal("document", { cookie: "" });
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          source: "converted",
          config: memberDraft({ name: "Ada" }),
          warnings: ["Unknown tool: Future"],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  for (const filename of ["checker.md", "checker.toml"]) {
    const value = await importAgentDocument("w", "pasted content", filename);
    expect(value.warnings).toEqual(["Unknown tool: Future"]);
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
      source: "pasted content",
      filename,
    });
  }
});

it("keeps the built-in role when switching a document with omitted tools", async () => {
  vi.stubGlobal("document", { cookie: "" });
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          source: "unchanged",
          config: memberDraft({
            name: "Executor",
            tools: ["files", "shell", "experiments"],
          }),
          warnings: [],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  await convertAgentDocument(
    "w",
    "---\nname: Executor\n---\nRun experiments",
    undefined,
    undefined,
    "executor",
  );
  expect(JSON.parse(fetcher.mock.calls[0][1].body).role).toBe("executor");
});
