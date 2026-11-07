import { expect, test } from "bun:test";
import { ChangeJournal } from "../src/change-journal";
import { createRPCHandler } from "../src/rpc";
import { Runtime } from "../src/runtime";

test("change replay preserves order, strips native fields and signals restart/overflow", () => {
  const journal = new ChangeJournal(2);
  const initial = journal.read({});
  expect(initial.reset).toBe(true);
  journal.append({ type: "one", data: { native: { secret: "private" }, public: true } });
  journal.append({ type: "two" });
  const batch = journal.read(initial);
  expect(batch.events.map((e) => e.type)).toEqual(["one", "two"]);
  expect(batch.events[0].data).toEqual({ public: true });
  journal.append({ type: "three" });
  expect(journal.read(initial).reset).toBe(true);
  expect(new ChangeJournal().read(batch).reset).toBe(true);
  expect(journal.read({ epoch: journal.epoch, cursor: 999 }).reset).toBe(true);
});
test("change waiters wake for events, expire, and release their slot on disconnect", async () => {
  const journal = new ChangeJournal(),
    cursor = journal.read({});
  const pending = journal.poll({ ...cursor, wait_ms: 1000 });
  journal.append({ type: "message.updated" });
  expect((await pending).events[0].type).toBe("message.updated");
  const latest = journal.read({ epoch: journal.epoch, cursor: 1 });
  expect((await journal.poll({ ...latest, wait_ms: 1 })).events).toEqual([]);
  const controller = new AbortController();
  const aborted = journal.poll({ ...latest, wait_ms: 1000 }, controller.signal);
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ code: "cancelled" });
});
test("oversized changes force recovery instead of silently losing the journal gap", () => {
  const journal = new ChangeJournal(10, 30),
    cursor = journal.read({});
  journal.append({ type: "message", data: { text: "x".repeat(100) } });
  expect(journal.read(cursor).reset).toBe(true);
});
test("change endpoint requires authentication and does not hold the runtime database queue", async () => {
  const runtime = new Runtime(),
    handler = createRPCHandler(runtime, "test-secret");
  const url =
    "http://localhost/trpc/changes?input=" + encodeURIComponent(JSON.stringify({ wait_ms: 0 }));
  expect((await handler(new Request(url))).status).toBe(401);
  const response = await handler(
    new Request(url, { headers: { Authorization: "Bearer test-secret" } }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).result.data.reset).toBe(true);
  expect(await runtime.operation(async () => "queue available")).toBe("queue available");
});
