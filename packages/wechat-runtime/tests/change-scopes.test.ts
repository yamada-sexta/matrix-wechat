import { expect, test } from "bun:test";
import {
  CommittedWrites,
  type DatabaseWrite,
  transactionEnd,
  writeScope,
} from "wechat-native/changes";

test("SQL scopes handle quoted/qualified writes and widen unknown statements", () => {
  expect(writeScope('INSERT OR REPLACE INTO "main"."Msg_a" VALUES(?)')).toEqual({ table: "msg_a" });
  expect(writeScope("UPDATE `Msg_b` SET server_id=?")).toEqual({ table: "msg_b" });
  expect(writeScope("DELETE FROM [Msg_c] WHERE local_id=?")).toEqual({ table: "msg_c" });
  expect(writeScope("WITH ids AS (SELECT 1) UPDATE Msg_d SET x=1")).toEqual({});
  expect(writeScope("CREATE TABLE Msg_new(x)")).toEqual({ schema: true });
  expect(transactionEnd("RELEASE SAVEPOINT top_level")).toBe(true);
  expect(transactionEnd("ROLLBACK TO nested")).toBe(true);
  expect(transactionEnd("/* trace */ COMMIT")).toBe(true);
  expect(transactionEnd("-- trace\n /* savepoint */ RELEASE top")).toBe(true);
  expect(writeScope("/* trace */ UPDATE Msg_a SET x=1")).toEqual({ table: "msg_a" });
});
test("writes accumulate until autocommit, coalesce publications, and unknown scope wins", () => {
  const writes: DatabaseWrite[] = [],
    scheduled: (() => void)[] = [];
  const tracker = new CommittedWrites(
    (change) => writes.push(change),
    (callback) => scheduled.push(callback),
  );
  // A nested RELEASE/ROLLBACK TO leaves autocommit false: the caller does not commit yet.
  tracker.record("db", "path", { table: "msg_a" });
  tracker.record("db", "path", { table: "msg_b" });
  expect(scheduled).toHaveLength(0);
  tracker.commit("db");
  tracker.record("db", "path", {});
  tracker.commit("db");
  expect(scheduled).toHaveLength(1);
  scheduled.shift()!();
  expect(writes).toEqual([{ id: "db", path: "path", schema: false, tables: undefined }]);
  tracker.record("db", "path", { table: "msg_a" });
  tracker.forget("db");
  tracker.commit("db");
  expect(scheduled).toHaveLength(0);
});
