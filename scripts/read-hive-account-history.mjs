#!/usr/bin/env node
/**
 * read-hive-account-history — pages a Hive account's operation history from two
 * independent public nodes (condenser_api.get_account_history), witnessing each page
 * between them, filtering to the standard ledger-relevant operation kinds and an
 * optional [from, to) time range, and carrying every VESTS field alongside its HP
 * equivalent at the chain's vests-to-HP ratio.
 */
import { HiveClient } from "@red-cup-engineering/hive-blockchain-client-service";
import {
  divideDecimalStrings,
  multiplyDecimalStrings,
  stripUnitSuffix,
} from "@red-cup-engineering/exact-number-data-service/decimal-string";

/** The operation kinds the Hive ledger derivation cares about; the roadmap's named set. */
export const DEFAULT_OPERATION_KINDS = [
  "transfer",
  "transfer_to_vesting",
  "transfer_to_vesting_completed",
  "withdraw_vesting",
  "fill_vesting_withdraw",
  "claim_reward_balance",
  "author_reward",
  "curation_reward",
  "comment_benefactor_reward",
  "fill_order",
  "limit_order_create",
  "limit_order_cancel",
  "transfer_to_savings",
  "transfer_from_savings",
  "cancel_transfer_from_savings",
  "interest",
  "fill_convert_request",
  "fill_collateralized_convert_request",
  "convert",
  "collateralized_convert",
  "proposal_pay",
  "delegate_vesting_shares",
];

const PAGE_LIMIT = 1000;
const VESTS_FIELDS = [
  "vesting_shares",
  "vesting_shares_received",
  "reward_vests",
  "withdrawn",
  "delegated_vesting_shares",
];

function toEpochMs(chainTimestamp) {
  return Date.parse(`${chainTimestamp}Z`);
}

/**
 * Whether a chain timestamp falls in `[from, to)`; either bound may be `null` (open).
 * @param {string} chainTimestamp
 * @param {string | null} from ISO instant
 * @param {string | null} to ISO instant
 * @returns {boolean}
 */
export function withinRange(chainTimestamp, from, to) {
  const t = toEpochMs(chainTimestamp);
  if (from && t < Date.parse(from)) return false;
  if (to && t >= Date.parse(to)) return false;
  return true;
}

/**
 * The vests-to-HP ratio (HIVE per VESTS) an operation itself records, when it records one;
 * `null` when the operation carries no embedded conversion.
 * @param {string} kind
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
export function opEmbeddedRatio(kind, payload) {
  if (kind === "transfer_to_vesting_completed") {
    const hive = stripUnitSuffix(String(payload.hive_vested ?? ""));
    const vests = stripUnitSuffix(String(payload.vesting_shares_received ?? ""));
    if (vests === "" || /^0(\.0+)?$/u.test(vests)) return null;
    return divideDecimalStrings(hive, vests, 12);
  }
  if (kind === "fill_vesting_withdraw") {
    const withdrawn = String(payload.withdrawn ?? "");
    const deposited = String(payload.deposited ?? "");
    if (!/VESTS$/u.test(withdrawn) || !/HIVE$/u.test(deposited)) return null;
    const vests = stripUnitSuffix(withdrawn);
    if (/^0(\.0+)?$/u.test(vests)) return null;
    return divideDecimalStrings(stripUnitSuffix(deposited), vests, 12);
  }
  return null;
}

/**
 * Every VESTS-carrying field of an operation payload, each with its HP equivalent at the
 * given ratio and a stated ratio source.
 * @param {Record<string, unknown>} payload
 * @param {string} ratio HIVE per VESTS
 * @param {"op-embedded" | "current-chain-ratio"} ratioSource
 * @returns {{ field: string, vests: string, hp: string, ratio: string, ratioSource: string }[]}
 */
export function vestsHpFields(payload, ratio, ratioSource) {
  const found = [];
  for (const field of VESTS_FIELDS) {
    const raw = payload[field];
    if (typeof raw !== "string" || !/VESTS$/u.test(raw)) continue;
    const vests = stripUnitSuffix(raw);
    found.push({ field, vests, hp: multiplyDecimalStrings(vests, ratio, 6), ratio, ratioSource });
  }
  return found;
}

/**
 * Whether two nodes' same-page results agree on every returned operation's identity
 * (index, transaction id, and operation kind).
 * @param {readonly [number, object][] | null} pageA
 * @param {readonly [number, object][] | null} pageB
 * @returns {boolean}
 */
export function pagesAgree(pageA, pageB) {
  if (!Array.isArray(pageA) || !Array.isArray(pageB)) return false;
  if (pageA.length !== pageB.length) return false;
  return pageA.every(([index, record], i) => {
    const [otherIndex, otherRecord] = pageB[i];
    return index === otherIndex && record.trx_id === otherRecord.trx_id && record.op[0] === otherRecord.op[0];
  });
}

/**
 * Read a Hive account's operation history since a range boundary, from two independent
 * public nodes, witnessed against each other page by page.
 * @param {{ account: string, nodes: readonly string[], operationKinds?: readonly string[],
 *   from?: { time?: string, sequence?: number }, to?: { time?: string } }} input
 *   `from.sequence` reads only operations after that account-history sequence number, for an
 *   incremental sync that already holds everything up to it.
 * @param {{ clientFactory?: (nodes: string[]) => HiveClient }} [options]
 * @returns {Promise<object>}
 * @throws {TypeError} When `input.account` is missing or `input.nodes` has fewer than two entries.
 */
export async function readHiveAccountHistory(input, { clientFactory } = {}) {
  if (!input || typeof input.account !== "string" || input.account === "") {
    throw new TypeError("read-hive-account-history: input.account must be a non-empty string");
  }
  if (!Array.isArray(input.nodes) || input.nodes.length < 2) {
    throw new TypeError("read-hive-account-history: input.nodes must list at least two node base URLs");
  }
  const { account } = input;
  const operationKindsList = input.operationKinds ?? DEFAULT_OPERATION_KINDS;
  const operationKinds = new Set(operationKindsList);
  const fromTime = input.from?.time ?? null;
  const fromSequence = Number.isInteger(input.from?.sequence) ? input.from.sequence : null;
  const toTime = input.to?.time ?? null;
  const makeClient = clientFactory ?? ((nodes) => new HiveClient({ nodes }));
  const primary = makeClient([input.nodes[0]]);
  const secondary = makeClient([input.nodes[1]]);

  const dgp = await primary.getDynamicGlobalProperties();
  const currentRatio = divideDecimalStrings(
    stripUnitSuffix(dgp.total_vesting_fund_hive),
    stripUnitSuffix(dgp.total_vesting_shares),
    12,
  );

  const operations = [];
  const refusals = [];
  let start = -1;
  let pagesFetched = 0;
  for (;;) {
    // condenser_api.get_account_history requires start >= limit - 1 unless start is -1 (head);
    // once paging backward reaches a low index, the page must shrink to fit under it.
    const limit = start === -1 ? PAGE_LIMIT : Math.min(PAGE_LIMIT, start + 1);
    // eslint-disable-next-line no-await-in-loop
    const pageA = await primary.getAccountHistory(account, start, limit);
    if (!Array.isArray(pageA) || pageA.length === 0) break;
    pagesFetched += 1;

    let pageB = null;
    let witnessError = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      pageB = await secondary.getAccountHistory(account, start, limit);
    } catch (error) {
      witnessError = String(error?.message ?? error);
    }
    const witnessOk = witnessError === null && pagesAgree(pageA, pageB);
    if (!witnessOk) {
      refusals.push({
        reason: witnessError ? "witness-fetch-failed" : "witness-disagreement",
        start,
        error: witnessError ?? undefined,
      });
    }

    const ordered = [...pageA].sort((a, b) => b[0] - a[0]);
    for (const [index, record] of ordered) {
      const kind = record.op[0];
      if (fromSequence !== null && index <= fromSequence) continue;
      if (!operationKinds.has(kind)) continue;
      if (!withinRange(record.timestamp, fromTime, toTime)) continue;
      const payload = record.op[1];
      const embeddedRatio = opEmbeddedRatio(kind, payload);
      const ratio = embeddedRatio ?? currentRatio;
      const ratioSource = embeddedRatio ? "op-embedded" : "current-chain-ratio";
      const vestsHp = vestsHpFields(payload, ratio, ratioSource);
      operations.push({
        index,
        block: record.block,
        trxId: record.trx_id,
        trxInBlock: record.trx_in_block,
        opInTrx: record.op_in_trx,
        virtual: record.virtual_op,
        timestamp: record.timestamp,
        kind,
        payload,
        ...(vestsHp.length ? { vestsHp } : {}),
        witnessed: witnessOk,
        witnessNodes: [input.nodes[0], input.nodes[1]],
      });
    }

    const indices = pageA.map(([index]) => index);
    const minIndex = Math.min(...indices);
    const oldestTimestampMs = Math.min(...pageA.map(([, record]) => toEpochMs(record.timestamp)));
    if (minIndex <= 0) break;
    if (fromTime && oldestTimestampMs < Date.parse(fromTime)) break;
    if (fromSequence !== null && minIndex <= fromSequence) break;
    start = minIndex - 1;
  }

  operations.sort((a, b) => a.index - b.index);
  return {
    account,
    nodesUsed: [input.nodes[0], input.nodes[1]],
    operationKinds: [...operationKinds],
    from: fromTime,
    fromSequence,
    to: toTime,
    pagesFetched,
    operationCount: operations.length,
    operations,
    vestsToHpRatio: {
      current: currentRatio,
      source: "condenser_api.get_dynamic_global_properties",
      atBlock: dgp.head_block_number,
    },
    refusals,
  };
}

if (import.meta.main) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const result = await readHiveAccountHistory(JSON.parse(text));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}
