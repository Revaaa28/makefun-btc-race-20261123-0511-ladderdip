# LADDER-DIP v1 — btc-race-24h-20261123-0511

A laddered dip buyer for cbBTC (CBBTC) on 1-minute bars, built for the
make.fun "Race a BTC trading bot live for 24 hours" competition
($1,000 paper start, cbBTC/USDC).

Instead of betting the whole stack on one dip signal, LADDER-DIP scales
into a falling knife in three arms, banks half the position on the first
rebound, and lets the rest ride behind a ratcheting trailing stop.

## Strategy

**Entry (arm 1).** The bot goes long when the latest close sits at least
100 bps below the trailing 60-bar high of closes **and** RSI(14) is at or
below 35. The first arm spends 70% of the cash on hand.

**Ladder arms.** While holding, if price keeps falling the bot adds —
but only when the move is deep *and* momentum is washed out:

- **Arm 2** — price is 55 bps or more below the blended entry and
  RSI ≤ 30: spend 80% of the *remaining* cash.
- **Arm 3** — price is 110 bps or more below the blended entry and
  RSI ≤ 26: spend everything that is left.

Arms fire at most once each and at least 3 bars apart, so the position
is built near the bottom of the dip rather than on the way down.

**Exits.**

- **Partial take-profit** — at +100 bps from the blended entry, sell half
  the position and start tracking a trailing peak from that bar.
- **Ratcheting trailing stop** — after the partial, if price falls 70 bps
  from the best close since the partial, sell everything.
- **Full take-profit** — at +200 bps from entry, sell everything.
- **Hard stop** — at −90 bps from entry, sell everything.
- **Time stop** — after 360 bars in the trade, sell everything.
- A 10-bar cooldown follows every exit before the next entry.

**Drawdown latch.** The bot tracks peak equity; if equity ever falls
150 bps below that peak, the latch trips and no new entries are taken
for the rest of the run (open positions still exit by the rules above).

All levels are measured from the position's true blended average fill
price, derived from its cost basis (fees included), so ladder adds move
the reference price exactly the way the account does.

## Dev-window grade

Measured with the kit's own harness on the frozen 24-hour dev window:

- Net PnL **+27.10 USDC**, 9 trades, win rate 100%
- Max drawdown **0.44%**, Sharpe **0.0601**

## Determinism

The bot is a pure function of the `hello` message and the `batch`
stream: no clock, no environment, no randomness. Two runs over the same
bars produce identical `orders` on every `bar`.

## Layout

- `main.ts` — the strategy (Node 22 / TypeScript, standard library only)
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK, vendored
- `LICENSE` — MIT
