import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_OPERATION_KINDS,
  opEmbeddedRatio,
  pagesAgree,
  readHiveAccountHistory,
  vestsHpFields,
  withinRange,
} from "../scripts/read-hive-account-history.mjs";

function fakeWaggle({ pages, dgp, throwOnSecondCall = false }) {
  let calls = 0;
  return {
    async getDynamicGlobalProperties() {
      return dgp;
    },
    async getAccountHistory(_account, start) {
      calls += 1;
      if (throwOnSecondCall && calls === 2) throw new Error("node unreachable");
      return pages[start] ?? [];
    },
  };
}

const DGP = { total_vesting_fund_hive: "200000000.000 HIVE", total_vesting_shares: "400000000000.000000 VESTS", head_block_number: 100 };

test("read-hive-account-history: throws on missing account", async () => {
  await assert.rejects(() => readHiveAccountHistory({ nodes: ["a", "b"] }), TypeError);
});

test("read-hive-account-history: throws on fewer than two nodes", async () => {
  await assert.rejects(() => readHiveAccountHistory({ account: "michael561", nodes: ["a"] }), TypeError);
});

test("read-hive-account-history: filters kinds, paginates, and stops at genesis", async () => {
  const pages = {
    "-1": [
      [2, { block: 10, trx_id: "t2", trx_in_block: 0, op_in_trx: 0, virtual_op: false, timestamp: "2026-09-01T00:00:00", op: ["transfer", { from: "a", to: "michael561", amount: "1.000 HIVE", memo: "" }] }],
      [1, { block: 9, trx_id: "t1", trx_in_block: 0, op_in_trx: 0, virtual_op: false, timestamp: "2026-08-31T00:00:00", op: ["vote", { voter: "michael561" }] }],
    ],
    "0": [
      [0, { block: 1, trx_id: "t0", trx_in_block: 0, op_in_trx: 0, virtual_op: false, timestamp: "2026-08-01T00:00:00", op: ["account_create", {} ] }],
    ],
  };
  const waggle = fakeWaggle({ pages, dgp: DGP });
  const result = await readHiveAccountHistory(
    { account: "michael561", nodes: ["nodeA", "nodeB"] },
    { clientFactory: () => waggle },
  );
  assert.equal(result.operationCount, 1); // only the transfer survives the default kind filter
  assert.equal(result.operations[0].kind, "transfer");
  assert.equal(result.operations[0].witnessed, true);
  assert.equal(result.pagesFetched, 2);
});

test("read-hive-account-history: a witness disagreement is refused, not thrown", async () => {
  const pages = {
    "-1": [[5, { block: 10, trx_id: "tA", trx_in_block: 0, op_in_trx: 0, virtual_op: false, timestamp: "2026-09-01T00:00:00", op: ["transfer", { amount: "1.000 HIVE" }] }]],
  };
  let call = 0;
  const primary = { async getDynamicGlobalProperties() { return DGP; }, async getAccountHistory(_a, start) { call += 1; return pages[start] ?? []; } };
  const secondary = { async getAccountHistory() { return [[5, { trx_id: "DIFFERENT", op: ["transfer", {}] }]]; } };
  let factoryCalls = 0;
  const clientFactory = () => { factoryCalls += 1; return factoryCalls === 1 ? primary : secondary; };
  const result = await readHiveAccountHistory({ account: "michael561", nodes: ["nodeA", "nodeB"] }, { clientFactory });
  assert.equal(result.refusals.length, 1);
  assert.equal(result.refusals[0].reason, "witness-disagreement");
  assert.equal(result.operations[0].witnessed, false);
  assert.equal(call, 2); // start=-1 fetches the one page, start=4 fetches an empty page and stops
});

test("opEmbeddedRatio: transfer_to_vesting_completed carries its own ratio", () => {
  const ratio = opEmbeddedRatio("transfer_to_vesting_completed", { hive_vested: "10.000 HIVE", vesting_shares_received: "20000.000000 VESTS" });
  assert.equal(ratio, "0.0005");
});

test("opEmbeddedRatio: an unrelated kind carries no ratio", () => {
  assert.equal(opEmbeddedRatio("transfer", { amount: "1.000 HIVE" }), null);
});

test("vestsHpFields: converts every VESTS field present using the given ratio", () => {
  const fields = vestsHpFields({ vesting_shares: "1000.000000 VESTS", other: "x" }, "0.0006", "current-chain-ratio");
  assert.equal(fields.length, 1);
  assert.equal(fields[0].hp, "0.6");
  assert.equal(fields[0].ratioSource, "current-chain-ratio");
});

test("withinRange: honors an inclusive-from, exclusive-to window", () => {
  assert.equal(withinRange("2026-09-01T00:00:00", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"), true);
  assert.equal(withinRange("2026-09-02T00:00:00", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"), false);
  assert.equal(withinRange("2026-08-31T23:59:59", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"), false);
});

test("pagesAgree: agrees only when index, trx_id, and kind all match", () => {
  const a = [[1, { trx_id: "x", op: ["transfer", {}] }]];
  const b = [[1, { trx_id: "x", op: ["transfer", {}] }]];
  const c = [[1, { trx_id: "y", op: ["transfer", {}] }]];
  assert.equal(pagesAgree(a, b), true);
  assert.equal(pagesAgree(a, c), false);
  assert.equal(pagesAgree(a, null), false);
});

test("read-hive-account-history: shrinks the page limit near genesis, per the chain's start >= limit-1 rule", async () => {
  const calls = [];
  const pages = { "-1": [[5, { block: 1, trx_id: "t5", timestamp: "2026-09-01T00:00:00", op: ["transfer", { amount: "1.000 HIVE" }] }]] };
  const waggle = {
    async getDynamicGlobalProperties() { return DGP; },
    async getAccountHistory(_a, start, limit) {
      calls.push({ start, limit });
      if (start === -1) return pages["-1"];
      return []; // start=4, limit must be 5 (start+1), never the full PAGE_LIMIT
    },
  };
  await readHiveAccountHistory({ account: "michael561", nodes: ["nodeA", "nodeB"] }, { clientFactory: () => waggle });
  assert.equal(calls[0].limit, 1000); // page 1 (primary), start=-1: full page limit
  const secondPageCall = calls.find((c) => c.start === 4);
  assert.equal(secondPageCall.limit, 5); // start + 1, not 1000 — the chain would reject 1000 here
});

test("DEFAULT_OPERATION_KINDS names the roadmap's operation set", () => {
  assert.ok(DEFAULT_OPERATION_KINDS.includes("claim_reward_balance"));
  assert.ok(DEFAULT_OPERATION_KINDS.includes("delegate_vesting_shares"));
  assert.equal(new Set(DEFAULT_OPERATION_KINDS).size, DEFAULT_OPERATION_KINDS.length);
});
