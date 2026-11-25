// Breakout Rider — pump.fun paper bot (24h horizon setting).
//
// Same engine as the 6h boothlord entry (beecoder77/pump-overhang-sniper):
// one engine, two horizon settings. Only the horizon numbers differ
// (paceSecs 86,400 for the 24h window; maxHold stays 400 — the backtester
// showed longer holds are worse even on 24h, because the completers' rise
// is captured within 400 slots and longer holds only eat the crash).
//
// Design (measured on the dev window, 2-3 Nov 2026, 1,222 mints, 128,058 events):
// - The completing curves are the edge. A mint that first crosses 3.5x its
//   first-trade price within 600 slots completes 35-58% of the time, and the
//   median price 300 slots after the cross is still 1.7-2.1x the cross price
//   (mean +58-61%). The path is a violent whipsaw (median intra-300-slot dip
//   to 0.2-0.3x), so every reactive exit loses: stop losses, trailing stops,
//   big-sell exits and take-profits all fire on noise and sell the winners
//   early. The only exit that works is a FIXED HOLD: buy the breakout, hold
//   exactly 400 slots, sell at whatever price. No stop, no trail, no fade,
//   no big-sell exit, no take-profit (all disabled by the constants below).
// - Pyramid only into confirmed strength: an add requires the position to
//   already be up >= 10% (value >= cost * 1.10) and the price stepped up
//   >= 5% from the last add, with net SOL still flowing in over the last
//   30 slots. Losers peak at only ~1.1x cost, so they never pyramid and
//   stay at the 0.3 SOL initial stake; winners peak at 1.5-2.25x cost and
//   build to the full 5 SOL stake. This single gate cut the drawdown from
//   44% to ~18% at the same PnL in the offline backtester.
// - Cross detection uses the recent 10-slot HIGH, not the last price, so a
//   breakout spike inside one batch is still caught; the fill then happens
//   at the (usually lower) current price. First-trade price is tracked per
//   mint and never pruned, so the cross is always measured from creation.
// - Sizing respects the harness caps: every buy is clamped to 1% of the
//   mint's real SOL reserve, 5 positions, 6 SOL exposure. A probe
//   round-trip keeps the 20-coin guardrail on pace.
// - Determinism: no clock, no environment, no Math.random; only the seeded
//   hello.seed exists and this bot does not even need it. All iteration is
//   over insertion-ordered maps fed by the batch stream.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";

const LAMPORTS = 1e9;
// Curve fee on every fill: protocol 95 bps + creator 30 bps fallback.
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Params {
  entryWindow: number;
  entryCrossX: number;
  breakoutMaxAge: number;
  crossHighWindow: number;
  entryMinRqSol: number;
  entryMaxRqSol: number;
  entryCooldown: number;
  entryMaxPerMint: number;
  initialSol: number;
  addSol: number;
  addStep: number;
  addIfUp: number;
  addFlowWindow: number;
  stakeSol: number;
  maxExposureSol: number;
  maxMain: number;
  tp1: number;
  tp2: number;
  trailArm: number;
  trail: number;
  stopLoss: number;
  fadeWindow: number;
  fadeNetSol: number;
  bigSellSol: number;
  maxHold: number;
  buySlipBps: number;
  sellSlipBps: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// 24h horizon setting (jackxyz72, top-3 pays — the more robust variant of
// the same engine: same breakout + fixed hold, the 24h pace spreads the
// guardrail probes over the full day). Backtester (exact AMM math, latency,
// fees, caps) on the 24h dev window: +14.53 SOL, max drawdown 17.5%,
// 54 main positions, 16 winners.
const P: Params = {
  entryWindow: 150,
  entryCrossX: 3.5,
  breakoutMaxAge: 600,
  crossHighWindow: 10,
  entryMinRqSol: 20,
  entryMaxRqSol: 200,
  entryCooldown: 150,
  entryMaxPerMint: 2,
  initialSol: 0.3,
  addSol: 0.6,
  addStep: 0.05,
  addIfUp: 0.1,
  addFlowWindow: 30,
  stakeSol: 5.0,
  maxExposureSol: 6,
  maxMain: 5,
  tp1: 999,
  tp2: 999,
  trailArm: 999,
  trail: 0.9,
  stopLoss: 0.95,
  fadeWindow: 60,
  fadeNetSol: -999,
  bigSellSol: 999,
  maxHold: 400,
  buySlipBps: 1500,
  sellSlipBps: 10_000,
  targetCoins: 30,
  targetFills: 300,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  firstPrice: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  tp1Done: boolean;
  tp2Done: boolean;
}

interface BotMemory {
  tapes: Map<Pubkey, Tape>;
  held: Map<Pubkey, Held>;
  probes: Map<Pubkey, boolean>;
  myFills: number;
  myCoins: Set<Pubkey>;
  firstTime: number | null;
  lastTime: number | null;
}

function newMemory(): BotMemory {
  return {
    tapes: new Map(),
    held: new Map(),
    probes: new Map(),
    myFills: 0,
    myCoins: new Set(),
    firstTime: null,
    lastTime: null,
  };
}

function tapeOf(mem: BotMemory, mint: Pubkey): Tape {
  let t = mem.tapes.get(mint);
  if (t === undefined) {
    t = { created: null, creator: null, firstPrice: null, trades: [], entries: 0, lastExit: -1e12 };
    mem.tapes.set(mint, t);
  }
  return t;
}

function priceOf(vq: number, vt: number): number {
  return vt > 0 ? vq / vt : 0;
}

// SOL a full sell of `tokens` would return now, curve + tx fees deducted.
function sellValueSol(tokens: number, vq: number, vt: number, txSol: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  const q = (tokens * vq) / (vt + tokens);
  return (q / LAMPORTS) * (1 - CURVE_FEE) - txSol;
}

// Net recorded SOL (buys minus sells) over the last `w` slots.
function flowSol(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

// Breakout entry signal: the curve's recent 10-slot high has crossed
// entryCrossX times its first-trade price, the curve is young (age at most
// breakoutMaxAge slots), real SOL reserves are deep enough to be a real
// run (20-200 SOL), and the creator has never sold (the bundled-dump
// filter). The cross is measured against the first trade, never a rolling
// window, so an old curve that already ran cannot re-trigger.
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < P.entryMinRqSol || rqSol > P.entryMaxRqSol) return false;
  if (t.created === null || t.firstPrice === null) return false;
  const age = now - t.created;
  if (age < 0 || age > P.breakoutMaxAge) return false;
  if (t.trades.length === 0) return false;
  let high = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - P.crossHighWindow) break;
    if (tr.price > high) high = tr.price;
  }
  if (high <= 0 || high / t.firstPrice < P.entryCrossX) return false;
  for (const tr of t.trades) {
    if (!tr.buy && t.creator !== null && tr.user === t.creator) return false;
  }
  return true;
}

// Exits for held positions. With the breakout design every reactive exit
// is disabled by the constants (stop 95%, trail armed at 999x, fade at
// -999 SOL, big-sell at 999 SOL, take-profits at 999x); the only exit that
// fires is the fixed hold: sell whole once the position is older than
// maxHold slots. The whipsaw path makes any earlier exit a loss.
function handleExits(
  mem: BotMemory,
  state: BotState,
  batch: Batch,
  orders: OrderInput[],
  pendingByMint: Map<Pubkey, number>,
  bigSell: Set<Pubkey>,
): void {
  const now = batch.slot;
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
  for (const [mint, h] of mem.held) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) {
        mem.held.delete(mint);
        const t = tapeOf(mem, mint);
        if (h.filled) t.lastExit = now;
        else t.entries--;
      }
      continue;
    }
    h.filled = true;
    if (curve === undefined || curve.complete) continue;
    const mk = marks.get(mint);
    const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
    const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
    const tokens = Number(pos.token_amount);
    const value = sellValueSol(tokens, vq, vt, tx);
    const cost = Number(pos.cost_lamports) / LAMPORTS;
    if (value > h.peakValue) h.peakValue = value;
    h.lastValue = value;
    const t = tapeOf(mem, mint);
    let sellFrac = 0;
    if (value < cost * (1 - P.stopLoss)) sellFrac = 1;
    else if (h.peakValue >= cost * (1 + P.trailArm) && value < h.peakValue * (1 - P.trail)) sellFrac = 1;
    else if (flowSol(t, now, P.fadeWindow) < P.fadeNetSol) sellFrac = 1;
    else if (bigSell.has(mint)) sellFrac = 1;
    else if (now - h.opened > P.maxHold) sellFrac = 1;
    else if (!h.tp2Done && value >= cost * (1 + P.tp2)) {
      sellFrac = 0.5;
      h.tp2Done = true;
    } else if (!h.tp1Done && value >= cost * (1 + P.tp1)) {
      sellFrac = 0.5;
      h.tp1Done = true;
    }
    if (sellFrac === 0) continue;
    let sellPending = false;
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === "sell") sellPending = true;
    }
    if (sellPending) continue;
    if (orders.length >= cap) break;
    const total = BigInt(pos.token_amount);
    const amount = sellFrac >= 1 ? total : total / 2n;
    if (amount <= 0n) continue;
    orders.push({ side: "sell", mint, token_amount: amount, max_slippage_bps: P.sellSlipBps });
    if (sellFrac >= 1) h.exiting = true;
  }
}

// Probe round trips: sell the whole probe as soon as its buy has landed.
function handleProbes(
  mem: BotMemory,
  state: BotState,
  orders: OrderInput[],
  pendingByMint: Map<Pubkey, number>,
): void {
  const cap = state.hello.caps.max_orders_per_batch;
  for (const [mint, selling] of mem.probes) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) mem.probes.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
    if (orders.length >= cap) break;
    orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlipBps });
    if (!selling) mem.probes.set(mint, true);
  }
}

// Entries and pyramid adds for the mints that traded in this batch.
function handleEntries(
  mem: BotMemory,
  state: BotState,
  batch: Batch,
  traded: Set<Pubkey>,
  orders: OrderInput[],
  pendingByMint: Map<Pubkey, number>,
): void {
  const now = batch.slot;
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  let free = Number(state.freeCashLamports()) / LAMPORTS;
  let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
  let mainLeft = P.maxMain - mem.held.size;
  let exposure = 0;
  for (const [mint, h] of mem.held) {
    exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
  }
  for (const mint of traded) {
    if (orders.length >= cap) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingByMint.has(mint) || mem.probes.has(mint)) continue;
    const t = mem.tapes.get(mint);
    if (t === undefined) continue;
    const h = mem.held.get(mint);
    const price = priceOf(Number(curve.virtual_quote_reserves), Number(curve.virtual_token_reserves));
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    let want: number;
    if (h === undefined) {
      if (slotsLeft <= 0 || mainLeft <= 0) continue;
      if (t.entries >= P.entryMaxPerMint || now - t.lastExit < P.entryCooldown) continue;
      if (!entrySignal(t, now, rqSol)) continue;
      want = Math.min(P.initialSol, P.stakeSol);
    } else {
      // Pyramid into confirmed strength only: the price stepped up from
      // the last add, the position is already up at least addIfUp, and net
      // SOL still flows in over the last addFlowWindow slots. Losers peak
      // near 1.1x cost and never qualify; winners do, and build to the
      // full stake while they run.
      if (h.exiting || !h.filled || h.invested >= P.stakeSol - 0.01) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      if (price < h.lastAddPrice * (1 + P.addStep)) continue;
      if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * (1 + P.addIfUp)) continue;
      if (flowSol(t, now, P.addFlowWindow) < 0) continue;
      if (rqSol > P.entryMaxRqSol) continue;
      want = Math.min(P.addSol, P.stakeSol - h.invested);
    }
    const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
    let amount = Math.min(capSol, want, P.maxExposureSol - exposure);
    if (amount > free - tx) amount = free - tx;
    if (amount < 0.02) continue;
    const lamports = BigInt(Math.floor(amount * LAMPORTS));
    if (lamports <= 0n) continue;
    orders.push({ side: "buy", mint, quote_lamports: lamports, max_slippage_bps: P.buySlipBps });
    free -= amount + tx;
    exposure += amount;
    if (h === undefined) {
      mem.held.set(mint, {
        opened: now,
        peakValue: 0,
        invested: amount,
        exiting: false,
        filled: false,
        lastAddPrice: price,
        lastValue: 0,
        tp1Done: false,
        tp2Done: false,
      });
      t.entries++;
      slotsLeft--;
      mainLeft--;
    } else {
      h.invested += amount;
      h.lastAddPrice = price;
    }
  }
}

// Guardrail pacing: open a probe when fills or coins lag the pace target.
// On the 24h horizon the pace spreads the 30-coin / 300-fill targets over
// the full day, so probes fire later than in the 6h setting; the main
// positions already cover the guardrail on their own.
function handlePacing(
  mem: BotMemory,
  state: BotState,
  batch: Batch,
  traded: Set<Pubkey>,
  orders: OrderInput[],
  pendingByMint: Map<Pubkey, number>,
  slotsLeft: number,
): void {
  if (mem.probes.size >= P.maxProbes || slotsLeft <= 0) return;
  if (mem.firstTime === null || mem.lastTime === null) return;
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  let free = Number(state.freeCashLamports()) / LAMPORTS;
  const pace = Math.min(1, (mem.lastTime - mem.firstTime) / P.paceSecs);
  const needCoins = mem.myCoins.size < Math.ceil(P.targetCoins * pace);
  const needFills = mem.myFills < Math.ceil(P.targetFills * pace);
  if (!needCoins && !needFills) return;
  const minRq = (P.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
  for (const mint of traded) {
    if (orders.length >= cap || mem.probes.size >= P.maxProbes) break;
    if (mem.held.has(mint) || mem.probes.has(mint) || pendingByMint.has(mint)) continue;
    if (state.positions.has(mint)) continue;
    if (needCoins && !needFills && mem.myCoins.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
    const t = mem.tapes.get(mint);
    if (t !== undefined && flowSol(t, batch.slot, P.fadeWindow) < P.fadeNetSol) continue;
    if (free < P.probeSol + 2 * tx) break;
    orders.push({
      side: "buy",
      mint,
      quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)),
      max_slippage_bps: P.buySlipBps,
    });
    mem.probes.set(mint, false);
    free -= P.probeSol + tx;
  }
}

function buildBot(): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const mem = newMemory();
  const keep = Math.max(P.entryWindow, P.fadeWindow) + 5;
  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === "filled" && !f.client_id.startsWith("_")) {
          mem.myFills++;
          mem.myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (mem.firstTime === null) mem.firstTime = e.block_time;
          if (mem.lastTime === null || e.block_time > mem.lastTime) mem.lastTime = e.block_time;
        }
        if (e.event === "CreateEvent") {
          const t = tapeOf(mem, e.mint);
          t.created = e.slot;
          if (t.creator === null) t.creator = e.creator;
        } else if (e.event === "TradeEvent") {
          const t = tapeOf(mem, e.mint);
          if (t.creator === null) t.creator = e.creator;
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = priceOf(Number(e.virtual_quote_reserves), Number(e.virtual_token_reserves));
          if (t.firstPrice === null) t.firstPrice = price;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price,
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= P.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = mem.tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      handleExits(mem, state, batch, orders, pendingByMint, bigSell);
      handleProbes(mem, state, orders, pendingByMint);
      handleEntries(mem, state, batch, traded, orders, pendingByMint);
      const slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      handlePacing(mem, state, batch, traded, orders, pendingByMint, slotsLeft);
      // Safety net: a position the strategy no longer tracks gets sold whole.
      const cap = state.hello.caps.max_orders_per_batch;
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (mem.held.has(mint) || mem.probes.has(mint) || pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlipBps });
      }
      return orders;
    },
  };
}

await runBot(buildBot());
