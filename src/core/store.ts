import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress, type Address, type Hex } from "viem";
import type {
  CampaignRunRecord,
  LaunchRecord,
  PositionRecord,
  TransactionRecord,
  TransactionStatus,
} from "./types.js";

type Row = Record<string, string | number | bigint | Uint8Array | null>;

export class StateStore {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertLaunch(record: LaunchRecord): void {
    this.db.prepare(`
      INSERT INTO launches (
        token, protocol, venue, venue_address, pair_token, quote_decimals,
        deployer, launch_block, stage, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        protocol = excluded.protocol,
        venue = excluded.venue,
        venue_address = excluded.venue_address,
        pair_token = excluded.pair_token,
        quote_decimals = excluded.quote_decimals,
        deployer = excluded.deployer,
        launch_block = excluded.launch_block,
        stage = excluded.stage,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `).run(
      record.token,
      record.protocol,
      record.venue,
      record.venueAddress,
      record.pairToken,
      record.quoteDecimals,
      record.deployer,
      record.launchBlock.toString(),
      record.stage,
      record.rawJson,
      record.createdAt,
      record.updatedAt,
    );
  }

  updateLaunchStage(
    token: Address,
    stage: LaunchRecord["stage"],
    venue: LaunchRecord["venue"],
    venueAddress?: Address,
  ): void {
    this.db.prepare(`
      UPDATE launches
      SET stage = ?, venue = ?, venue_address = COALESCE(?, venue_address), updated_at = ?
      WHERE token = ? COLLATE NOCASE
    `).run(stage, venue, venueAddress ?? null, Date.now(), token);
  }

  getLaunch(token: Address): LaunchRecord | null {
    const row = this.db.prepare("SELECT * FROM launches WHERE token = ? COLLATE NOCASE").get(token) as
      | Row
      | undefined;
    return row ? launchFromRow(row) : null;
  }

  recordTransaction(record: TransactionRecord): void {
    this.db.prepare(`
      INSERT INTO transactions (
        hash, wallet, token, action, nonce, status, amount_in, min_out,
        actual_out, error, submitted_at, confirmed_at, block_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        status = excluded.status,
        actual_out = excluded.actual_out,
        error = excluded.error,
        confirmed_at = excluded.confirmed_at,
        block_number = excluded.block_number
    `).run(
      record.hash,
      record.wallet,
      record.token,
      record.action,
      record.nonce,
      record.status,
      record.amountIn.toString(),
      record.minOut.toString(),
      record.actualOut?.toString() ?? null,
      record.error,
      record.submittedAt,
      record.confirmedAt,
      record.blockNumber?.toString() ?? null,
    );
  }

  updateTransaction(
    hash: Hex,
    status: TransactionStatus,
    fields: { actualOut?: bigint; error?: string; confirmedAt?: number; blockNumber?: bigint } = {},
  ): void {
    this.db.prepare(`
      UPDATE transactions
      SET status = ?, actual_out = COALESCE(?, actual_out), error = ?,
          confirmed_at = COALESCE(?, confirmed_at), block_number = COALESCE(?, block_number)
      WHERE hash = ? COLLATE NOCASE
    `).run(
      status,
      fields.actualOut?.toString() ?? null,
      fields.error ?? null,
      fields.confirmedAt ?? null,
      fields.blockNumber?.toString() ?? null,
      hash,
    );
  }

  listPendingTransactions(): TransactionRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM transactions WHERE status = 'submitted' ORDER BY submitted_at",
    ).all() as Row[];
    return rows.map(transactionFromRow);
  }

  upsertPosition(record: PositionRecord): void {
    this.db.prepare(`
      INSERT INTO positions (
        wallet, wallet_name, token, protocol, venue, venue_address, pair_token,
        quote_decimals, symbol, tokens, cost_basis, realized_quote, opened_at,
        entry_tx_hash, strategy_id, status, highest_multiple, closed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet, token) DO UPDATE SET
        wallet_name = excluded.wallet_name,
        venue = excluded.venue,
        venue_address = excluded.venue_address,
        tokens = excluded.tokens,
        cost_basis = excluded.cost_basis,
        realized_quote = excluded.realized_quote,
        strategy_id = excluded.strategy_id,
        status = excluded.status,
        highest_multiple = excluded.highest_multiple,
        closed_at = excluded.closed_at,
        updated_at = excluded.updated_at
    `).run(
      record.wallet,
      record.walletName,
      record.token,
      record.protocol,
      record.venue,
      record.venueAddress,
      record.pairToken,
      record.quoteDecimals,
      record.symbol,
      record.tokens.toString(),
      record.costBasis.toString(),
      record.realizedQuote.toString(),
      record.openedAt,
      record.entryTxHash,
      record.strategyId,
      record.status,
      record.highestMultiple,
      record.closedAt,
      record.updatedAt,
    );
  }

  getPosition(wallet: Address, token: Address): PositionRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM positions WHERE wallet = ? COLLATE NOCASE AND token = ? COLLATE NOCASE",
    ).get(wallet, token) as Row | undefined;
    return row ? positionFromRow(row) : null;
  }

  listOpenPositions(): PositionRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at, wallet_name",
    ).all() as Row[];
    return rows.map(positionFromRow);
  }

  markRuleTriggered(wallet: Address, token: Address, ruleId: string, txHash: Hex | null): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO position_rules (wallet, token, rule_id, triggered_at, tx_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(wallet, token, ruleId, Date.now(), txHash);
  }

  isRuleTriggered(wallet: Address, token: Address, ruleId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS present FROM position_rules
      WHERE wallet = ? COLLATE NOCASE AND token = ? COLLATE NOCASE AND rule_id = ?
    `).get(wallet, token, ruleId) as Row | undefined;
    return row !== undefined;
  }

  saveCampaignRun(record: CampaignRunRecord): void {
    this.db.prepare(`
      INSERT INTO campaign_runs (
        id, campaign_name, mode, status, context_json, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        context_json = excluded.context_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.campaignName,
      record.mode,
      record.status,
      record.contextJson,
      record.startedAt,
      record.updatedAt,
    );
  }

  setCheckpoint(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO checkpoints (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  getCheckpoint(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM checkpoints WHERE key = ?").get(key) as
      | Row
      | undefined;
    return row ? String(row["value"]) : null;
  }

  summary(): { launches: number; openPositions: number; pendingTransactions: number } {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM launches) AS launches,
        (SELECT COUNT(*) FROM positions WHERE status = 'open') AS open_positions,
        (SELECT COUNT(*) FROM transactions WHERE status = 'submitted') AS pending_transactions
    `).get() as Row;
    return {
      launches: Number(row["launches"]),
      openPositions: Number(row["open_positions"]),
      pendingTransactions: Number(row["pending_transactions"]),
    };
  }

  private migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row)["user_version"]);
    if (version > 1) throw new Error(`State database schema ${version} is newer than this application`);
    if (version === 1) return;

    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE launches (
          token TEXT PRIMARY KEY COLLATE NOCASE,
          protocol TEXT NOT NULL,
          venue TEXT NOT NULL,
          venue_address TEXT NOT NULL COLLATE NOCASE,
          pair_token TEXT NOT NULL COLLATE NOCASE,
          quote_decimals INTEGER NOT NULL,
          deployer TEXT NOT NULL COLLATE NOCASE,
          launch_block TEXT NOT NULL,
          stage TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE transactions (
          hash TEXT PRIMARY KEY COLLATE NOCASE,
          wallet TEXT NOT NULL COLLATE NOCASE,
          token TEXT COLLATE NOCASE,
          action TEXT NOT NULL,
          nonce INTEGER NOT NULL,
          status TEXT NOT NULL,
          amount_in TEXT NOT NULL,
          min_out TEXT NOT NULL,
          actual_out TEXT,
          error TEXT,
          submitted_at INTEGER NOT NULL,
          confirmed_at INTEGER,
          block_number TEXT
        );
        CREATE INDEX transactions_status_idx ON transactions(status, submitted_at);
        CREATE TABLE positions (
          wallet TEXT NOT NULL COLLATE NOCASE,
          wallet_name TEXT NOT NULL,
          token TEXT NOT NULL COLLATE NOCASE,
          protocol TEXT NOT NULL,
          venue TEXT NOT NULL,
          venue_address TEXT NOT NULL COLLATE NOCASE,
          pair_token TEXT NOT NULL COLLATE NOCASE,
          quote_decimals INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          tokens TEXT NOT NULL,
          cost_basis TEXT NOT NULL,
          realized_quote TEXT NOT NULL,
          opened_at INTEGER NOT NULL,
          entry_tx_hash TEXT NOT NULL COLLATE NOCASE,
          strategy_id TEXT NOT NULL,
          status TEXT NOT NULL,
          highest_multiple REAL NOT NULL,
          closed_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (wallet, token)
        );
        CREATE INDEX positions_status_idx ON positions(status, opened_at);
        CREATE TABLE position_rules (
          wallet TEXT NOT NULL COLLATE NOCASE,
          token TEXT NOT NULL COLLATE NOCASE,
          rule_id TEXT NOT NULL,
          triggered_at INTEGER NOT NULL,
          tx_hash TEXT COLLATE NOCASE,
          PRIMARY KEY (wallet, token, rule_id)
        );
        CREATE TABLE campaign_runs (
          id TEXT PRIMARY KEY,
          campaign_name TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          context_json TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE checkpoints (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);
    });
  }
}

function launchFromRow(row: Row): LaunchRecord {
  return {
    token: getAddress(String(row["token"])),
    protocol: String(row["protocol"]) as LaunchRecord["protocol"],
    venue: String(row["venue"]) as LaunchRecord["venue"],
    venueAddress: getAddress(String(row["venue_address"])),
    pairToken: getAddress(String(row["pair_token"])),
    quoteDecimals: Number(row["quote_decimals"]),
    deployer: getAddress(String(row["deployer"])),
    launchBlock: BigInt(String(row["launch_block"])),
    stage: String(row["stage"]) as LaunchRecord["stage"],
    rawJson: String(row["raw_json"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function transactionFromRow(row: Row): TransactionRecord {
  return {
    hash: String(row["hash"]) as Hex,
    wallet: getAddress(String(row["wallet"])),
    token: row["token"] === null ? null : getAddress(String(row["token"])),
    action: String(row["action"]) as TransactionRecord["action"],
    nonce: Number(row["nonce"]),
    status: String(row["status"]) as TransactionRecord["status"],
    amountIn: BigInt(String(row["amount_in"])),
    minOut: BigInt(String(row["min_out"])),
    actualOut: row["actual_out"] === null ? null : BigInt(String(row["actual_out"])),
    error: row["error"] === null ? null : String(row["error"]),
    submittedAt: Number(row["submitted_at"]),
    confirmedAt: row["confirmed_at"] === null ? null : Number(row["confirmed_at"]),
    blockNumber: row["block_number"] === null ? null : BigInt(String(row["block_number"])),
  };
}

function positionFromRow(row: Row): PositionRecord {
  return {
    wallet: getAddress(String(row["wallet"])),
    walletName: String(row["wallet_name"]),
    token: getAddress(String(row["token"])),
    protocol: String(row["protocol"]) as PositionRecord["protocol"],
    venue: String(row["venue"]) as PositionRecord["venue"],
    venueAddress: getAddress(String(row["venue_address"])),
    pairToken: getAddress(String(row["pair_token"])),
    quoteDecimals: Number(row["quote_decimals"]),
    symbol: String(row["symbol"]),
    tokens: BigInt(String(row["tokens"])),
    costBasis: BigInt(String(row["cost_basis"])),
    realizedQuote: BigInt(String(row["realized_quote"])),
    openedAt: Number(row["opened_at"]),
    entryTxHash: String(row["entry_tx_hash"]) as Hex,
    strategyId: String(row["strategy_id"]),
    status: String(row["status"]) as PositionRecord["status"],
    highestMultiple: Number(row["highest_multiple"]),
    closedAt: row["closed_at"] === null ? null : Number(row["closed_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}
