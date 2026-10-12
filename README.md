# @red-cup-engineering/read-hive-account-history-service

Reads a Hive account's operation history, paged from two independent public nodes via `condenser_api.get_account_history` and witnessed against each other page by page, filtered to the standard ledger-relevant operation kinds (`transfer`, `transfer_to_vesting`, `withdraw_vesting`, `fill_vesting_withdraw`, `claim_reward_balance`, `author_reward`, `curation_reward`, `fill_order`, `limit_order_create`/`cancel`, `transfer_to_savings`/`from`, `interest`, `fill_convert_request`, the collateralized-convert pair, `proposal_pay`, `delegate_vesting_shares`, and their supporting virtual/completion ops) and an optional `[from, to)` time range. Every VESTS-carrying field is carried alongside its HP equivalent at the chain's vests-to-HP ratio: the operation's own embedded conversion (`transfer_to_vesting_completed`, `fill_vesting_withdraw`) when it records one, else the current chain ratio — both stated on the field so a consumer never confuses the two. Read-only; no key is ever required or accepted.

## Operation

~~~js
export async function readHiveAccountHistory(input, options)
~~~

### Parameters

- input (`{ account: string, nodes: readonly string[], operationKinds?: readonly string[], from?: { time?: string }, to?: { time?: string } }`): the account to read, at least two node base URLs, an optional override of the default operation-kind set, and an optional `[from.time, to.time)` window (ISO instants; omit both for the account's whole history).
- options (`{ waggleFactory?: (nodes: string[]) => Waggle }`): for tests — a factory returning a `Waggle`-shaped object exposing `getDynamicGlobalProperties()` and `getAccountHistory(account, start, limit)`. Defaults to real `@red-cup-engineering/hive-blockchain-client-service` reads.

### Returns

`{ account, nodesUsed, operationKinds, from, to, pagesFetched, operationCount, operations, vestsToHpRatio, refusals }`. Each operation carries `{ index, block, trxId, trxInBlock, opInTrx, virtual, timestamp, kind, payload, vestsHp?, witnessed, witnessNodes }` with every amount kept as the chain's own exact decimal string. `refusals` lists each page whose two nodes disagreed (`witness-disagreement`) or whose second node could not be reached (`witness-fetch-failed`); the page's operations are still returned, each marked `witnessed: false`, so a consumer decides how to treat an unwitnessed operation rather than losing it silently.

### Refusals

- `TypeError`: when `input.account` is missing or `input.nodes` has fewer than two entries.

## Command

read-hive-account-history reads one JSON value on stdin and writes one JSON value to stdout.
