import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runProposalTurn } from "../src/gateway/propose.js";
import { proposalPolicyMessage } from "../src/gateway/proposalPrompt.js";
import { ProposalStore } from "../src/main/proposalStore.js";
import { ProposalSession } from "../src/main/proposalSession.js";
import { PROPOSE_TOOL_NAME } from "../src/shared/proposal.js";
import type { ChatRequest, ChatResponse } from "../src/shared/ai.js";

let tmp: string;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * [→E2E] The full write-back loop, headless: a chat turn produces a proposal via
 * the real runProposalTurn (with a scripted gateway standing in for the model),
 * the proposal is persisted + queued through the real ProposalSession sink, the
 * diff is reviewed, approved, and the note lands correctly on disk through the
 * guarded safe-write layer. Mirrors the existing vaultSession smoke.
 */
describe("write-back loop E2E (chat → proposal → review → approve → disk)", () => {
  it("queues an append proposal and applies it to the real note on approval", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sb-e2e-"));
    const vault = path.join(tmp, "vault");
    await fs.mkdir(vault, { recursive: true });
    const dailyPath = path.join(vault, "Daily.md");
    await fs.writeFile(dailyPath, "# Daily\n", "utf8");

    const store = new ProposalStore(path.join(tmp, "store"));
    const applied: string[] = [];
    const session = new ProposalSession({
      store,
      getRoot: () => vault,
      onApplied: (paths) => applied.push(...paths),
    });

    // 1. Chat turn: a scripted gateway emits a propose_note_edit tool call.
    const gateway = {
      call(_req: ChatRequest): Promise<ChatResponse> {
        return Promise.resolve({
          provider: "anthropic",
          model: "m",
          text: "Logged it for you.",
          toolCalls: [
            {
              name: PROPOSE_TOOL_NAME,
              input: {
                kind: "append",
                targetPath: "Daily.md",
                content: "- shipped the write-back loop",
                reason: "record today's win",
              },
            },
          ],
        });
      },
    };
    const { parsed } = await runProposalTurn(gateway, {
      model: { provider: "anthropic", model: "m" },
      messages: [
        proposalPolicyMessage(),
        { role: "user", content: "log that I shipped the write-back loop" },
      ],
    });
    expect(parsed.text).toContain("Logged it");
    expect(parsed.proposal?.kind).toBe("append");

    // 2. Persist through the same sink the app wires (path-security checked).
    const stored = await session.create(parsed.proposal!, { chatId: "c1", turnTs: 1 });
    expect(stored).not.toBeNull();

    // 3. The review queue shows it as a pending diff (append preview).
    const queued = await session.list();
    expect(queued.map((p) => p.state)).toContain("pending");
    const blocks = await session.diff(stored!.id);
    expect(blocks.find((b) => b.type === "change")).toMatchObject({
      add: ["- shipped the write-back loop"],
    });

    // 4. Approve → the note is correct on disk; reindex hook fired.
    const result = await session.approve(stored!.id);
    expect(result.status).toBe("applied");
    expect(await fs.readFile(dailyPath, "utf8")).toBe(
      "# Daily\n- shipped the write-back loop\n"
    );
    expect(applied).toContain(dailyPath);

    // 5. The proposal is recorded approved in the auditable history.
    const hist = await store.history();
    expect(hist.find((p) => p.id === stored!.id)?.state).toBe("applied");
  });
});
