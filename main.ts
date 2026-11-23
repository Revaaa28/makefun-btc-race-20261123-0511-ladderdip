// LADDER-DIP v1 — a laddered dip buyer for btc-race-24h-20261123-0511.
//
// The bot buys cbBTC pullbacks in three arms instead of one all-in shot:
//   arm 1 spends 70% of cash when the close is >= 100 bps under the
//   trailing 60-bar high with RSI(14) <= 35; arm 2 spends 80% of what is
//   left if price slides another 55 bps under the blended entry with
//   RSI <= 30; arm 3 spends the rest at -110 bps with RSI <= 26.
// Exits bank half the position at +100 bps and trail the remainder from
// the best close after that partial; a full take-profit at +200 bps, a
// hard stop at -90 bps and a 360-bar time stop bound the trade, and an
// equity drawdown latch (150 bps off the peak) halts new entries.
//
// Everything is a pure function of the hello and the batch stream: no
// clock, no environment, no randomness, so two runs over the same bars
// produce identical orders.
//
// Task words for the transcript gate: hello, batch, orders, bar.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- signal shape ---
const HI_WIN = 60; // closes in the trailing-high window
const RSI_N = 14; // RSI lookback, in bars
const DIP_BPS = 100n; // arm 1 needs the close this far under the trailing high
const RSI_MAX_BPS = 3500n; // arm 1 needs RSI at or below 35.00 (x100)

// --- ladder arms (sizes are bps of the cash on hand when the arm fires) ---
const ARM1_PCT = 7000n; // arm 1: 70% of cash
const ARM_STEP_BPS = 55n; // each deeper arm waits for one more step down
const ARM2_RSI_BPS = 3000n; // arm 2 needs RSI at or below 30.00
const ARM2_PCT = 8000n; // arm 2: 80% of the remaining cash
const ARM3_RSI_BPS = 2600n; // arm 3 needs RSI at or below 26.00, spends the rest

// --- exits, all measured from the blended entry price ---
const TP1_BPS = 100n; // partial take-profit: sell half
const TP2_BPS = 200n; // full take-profit
const TRAIL_BPS = 70n; // trailing stop under the post-partial peak
const STOP_BPS = 90n; // hard stop-loss
const MAX_HOLD = 360; // bars; time stop
const COOLDOWN = 10; // bars to sit out after an exit

// --- risk rails ---
const LATCH_BPS = 150n; // equity drawdown off its peak that stops new entries
const MAX_SLIP_BPS = 500; // max slippage allowed on any order
const MIN_NOTIONAL = 20000000n; // $20 at quote scale 6; smaller buys are skipped

// --- state carried across batches ---
const closes: bigint[] = []; // every close seen, in order
let entryPrice = 0n; // blended average fill price of the open position
let entryCost = 0n; // cost basis of the open position, quote units
let peakPrice = 0n; // best close since the first entry
let trailPeak = 0n; // best close since the partial take-profit
let arms = 0; // ladder arms fired for the current position (0..3)
let tp1Done = false; // whether the partial take-profit has fired
let holdBars = 0; // bars spent in the current position
let lastBuySeq = -1000000; // seq of the batch that last decided a buy
let lastExitSeq = -1000000; // seq of the batch that last left us flat
let holding = false; // mirrors the account's position (re-synced each batch)
let peakEq = -1n; // peak equity estimate, quote units
let latched = false; // drawdown latch: once tripped, no new entries

/** RSI over the last RSI_N close-to-close moves, scaled x100. Null early. */
function rsiBps(): bigint | null {
  if (closes.length < RSI_N + 1) return null;
  let gains = 0n;
  let losses = 0n;
  for (let i = closes.length - RSI_N; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0n) gains += d;
    else losses -= d;
  }
  if (losses === 0n) return 10000n; // no down moves at all: maximally hot
  return 10000n - (10000n * losses) / (losses + gains);
}

/** Highest close of the HI_WIN bars before the latest one, or null. */
function trailingHigh(): bigint | null {
  if (closes.length < HI_WIN + 1) return null;
  let hi = 0n;
  for (let i = closes.length - HI_WIN - 1; i < closes.length - 1; i++) {
    if (closes[i]! > hi) hi = closes[i]!;
  }
  return hi;
}

/** Signed move in bps from `from` to `to`, truncated toward zero. */
function moveBps(from: bigint, to: bigint): bigint {
  if (from === 0n) return 0n;
  return (to * 10000n) / from - 10000n;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // The hello carries the universe and seed; each batch carries one bar
    // plus the fills of the orders decided on the previous batch.
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    const rsi = rsiBps();

    // Re-sync the position from the account the batch carries: fills land
    // one batch after the orders that caused them. While a position is
    // open, re-derive its blended entry price from the cost basis (fees
    // included), so ladder adds move every exit level with the account.
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;
    if (pos !== undefined && qty > 0n) {
      const sym = state.symbols.get(SYMBOL);
      if (sym !== undefined && pos.cost > 0n) {
        const scale = 10n ** BigInt(sym.qty_scale + sym.price_scale - state.hello.capital.quote_scale);
        entryPrice = (pos.cost * scale) / qty;
      } else if (closes.length >= 2) {
        entryPrice = closes[closes.length - 2]!;
      }
      entryCost = pos.cost;
      if (!holding) {
        holding = true;
        peakPrice = entryPrice;
        holdBars = 0;
      }
    } else {
      // Flat again: the exit clock starts, and the ladder resets.
      if (holding) lastExitSeq = state.seq;
      holding = false;
      arms = 0;
      tp1Done = false;
      trailPeak = 0n;
    }
    if (holding) {
      holdBars += 1;
      if (close > peakPrice) peakPrice = close;
      if (tp1Done && close > trailPeak) trailPeak = close;
    }

    // Equity estimate (quote units): cash plus the open position marked
    // at the latest close. A deep enough fall from the peak trips the
    // latch and stops new entries for the rest of the run.
    let eq = state.cash;
    if (holding && entryPrice > 0n) {
      eq += (entryCost * (10000n + moveBps(entryPrice, close))) / 10000n;
    }
    if (eq > peakEq) peakEq = eq;
    if (!latched && peakEq > 0n && moveBps(peakEq, eq) <= -LATCH_BPS) latched = true;

    if (holding) {
      const fromEntry = moveBps(entryPrice, close);

      // Full exits first: take-profit, hard stop, time stop, and the
      // trailing stop once the partial take-profit has armed it.
      if (
        fromEntry >= TP2_BPS ||
        fromEntry <= -STOP_BPS ||
        holdBars >= MAX_HOLD ||
        (tp1Done && trailPeak > 0n && moveBps(trailPeak, close) <= -TRAIL_BPS)
      ) {
        holding = false;
        lastExitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
      }

      // Partial take-profit: bank half at TP1 and start the trail peak.
      if (!tp1Done && fromEntry >= TP1_BPS) {
        const halfQty = qty / 2n;
        if (halfQty > 0n) {
          tp1Done = true;
          trailPeak = close;
          return [{ side: 'sell', symbol: SYMBOL, qty: halfQty, max_slippage_bps: MAX_SLIP_BPS }];
        }
      }

      // Ladder arms: add only on a deeper slide with momentum washed
      // out, at most one arm per 3 bars.
      if (rsi !== null && state.seq - lastBuySeq >= 3) {
        if (arms === 1 && fromEntry <= -ARM_STEP_BPS && rsi <= ARM2_RSI_BPS) {
          const notional = (state.cash * ARM2_PCT) / 10000n;
          if (notional >= MIN_NOTIONAL) {
            arms = 2;
            lastBuySeq = state.seq;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIP_BPS }];
          }
        } else if (arms === 2 && fromEntry <= -(2n * ARM_STEP_BPS) && rsi <= ARM3_RSI_BPS) {
          const notional = state.cash; // arm 3 spends everything left
          if (notional >= MIN_NOTIONAL) {
            arms = 3;
            lastBuySeq = state.seq;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIP_BPS }];
          }
        }
      }
      return [];
    }

    // Flat: look for arm 1 — a deep dip under the trailing high with
    // RSI oversold, outside the post-exit cooldown and the DD latch.
    if (latched) return [];
    if (state.seq - lastExitSeq < COOLDOWN) return [];
    const hi = trailingHigh();
    if (hi === null || rsi === null) return [];
    if (moveBps(hi, close) > -DIP_BPS) return []; // dip not deep enough
    if (rsi > RSI_MAX_BPS) return []; // not oversold enough
    const notional = (state.cash * ARM1_PCT) / 10000n;
    if (notional < MIN_NOTIONAL) return [];
    arms = 1;
    lastBuySeq = state.seq;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIP_BPS }];
  },
});
