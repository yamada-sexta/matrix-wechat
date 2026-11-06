import { expect, test } from "bun:test";
import { DownloadRetry } from "../src/download-retry";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("native download requests stay bounded, deduplicate in flight, and retry after failure", async () => {
  let now = 100,
    calls = 0;
  const retry = new DownloadRetry(() => now);
  const completions: (() => void)[] = [];
  const task = () => {
    calls++;
    return new Promise<void>((resolve) => completions.push(resolve));
  };
  retry.request("account/chat/1", task);
  retry.request("account/chat/1", task);
  retry.request("account/chat/2", task);
  retry.request("account/chat/3", task);
  await tick();
  expect(calls).toBe(2);
  now += 60001;
  retry.request("account/chat/1", task);
  await tick();
  expect(calls).toBe(2);
  completions.splice(0).forEach((resolve) => resolve());
  await tick();
  retry.request("account/chat/1", async () => {
    calls++;
    throw Error("CDN temporarily unavailable");
  });
  await tick();
  expect(calls).toBe(3);
  retry.request("account/chat/1", task);
  await tick();
  expect(calls).toBe(3);
  now += 60001;
  retry.request("account/chat/1", task);
  await tick();
  expect(calls).toBe(4);
  completions.splice(0).forEach((resolve) => resolve());
  await tick();
});

test("a blocked request does not prevent another account/message from requesting its original", async () => {
  const retry = new DownloadRetry();
  let finish: () => void = () => {};
  retry.request(
    "account-a/chat/1",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let completed = false;
  retry.request("account-b/chat/1", async () => {
    completed = true;
  });
  await tick();
  expect(completed).toBe(true);
  finish();
  await tick();
});
