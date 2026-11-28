import { describe, expect, it, vi } from "vitest";
import { openAttachment } from "./download.ts";

describe("openAttachment", () => {
  it("makes sure the session is fresh before the download starts", async () => {
    const order: string[] = [];
    const session = {
      ensureFresh: vi.fn(async () => {
        order.push("ensureFresh");
        return true;
      }),
    };
    await openAttachment(session, "/bff/api/attachments/A_1", "a.pdf", (href, name) => order.push(`save ${href} ${name}`));
    expect(order).toEqual(["ensureFresh", "save /bff/api/attachments/A_1 a.pdf"]);
  });

  it("doesn't start the download when the session is over", async () => {
    const save = vi.fn();
    await openAttachment({ ensureFresh: async () => false }, "/bff/api/attachments/A_1", "a.pdf", save);
    expect(save).not.toHaveBeenCalled();
  });

  it("still starts the download when the check can't reach the BFF", async () => {
    const save = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await openAttachment(
      {
        ensureFresh: async () => {
          throw new TypeError("offline");
        },
      },
      "/bff/api/attachments/A_1",
      "a.pdf",
      save,
    );
    expect(save).toHaveBeenCalledWith("/bff/api/attachments/A_1", "a.pdf");
    warn.mockRestore();
  });
});
