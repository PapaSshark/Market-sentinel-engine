const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const SYMBOLS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD",
  "EUR/GBP",
  "XAU/USD"
];

const INTERVALS = ["5min", "15min", "1h"];

const CONFIG = {
  bars: 250,

  // Numero minimo di test necessari per considerare valida una zona
  minTests: 2,

  // Stop Loss automatico
  stopAtrMult: 1.35,
  stopZoneMult: 1.60,
  stopBufferAtrMult: 0.20,

  // Take Profit automatico
  rr: 2,

  // Zone
  zoneAtrMult: 0.35,
  approachAtrMult: 1.5,

  // Swing
  swingLeft: 3,
  swingRight: 3
};

let lastScan = null;
let lastScanAt = 0;
let scanPromise = null;

// Il frontend aggiorna ogni 60 secondi.
// Lasciamo un piccolo margine per evitare richieste duplicate.
const CACHE_MS = 55 * 1000;


// ----------------------------------------------------
// UTILITY
// ----------------------------------------------------

function roundPrice(value, decimals) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function decimalsForSymbol(symbol) {
  if (symbol === "USD/JPY") return 3;
  if (symbol === "XAU/USD") return 2;

  return 5;
}

function normalizeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}


// ----------------------------------------------------
// TWELVE DATA
// ----------------------------------------------------

async function getTimeSeries(symbol, interval) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY non configurata");
  }

  const params = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(CONFIG.bars),
    order: "ASC",
    apikey: TWELVE_DATA_API_KEY
  });

  const url =
    `https://api.twelvedata.com/time_series?${params.toString()}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(data.message || "Errore Twelve Data");
  }

  if (!Array.isArray(data.values) || data.values.length < 30) {
    throw new Error("Dati insufficienti");
  }

  return data.values
    .map(c => ({
      datetime: c.datetime,
      open: normalizeNumber(c.open),
      high: normalizeNumber(c.high),
      low: normalizeNumber(c.low),
      close: normalizeNumber(c.close)
    }))
    .filter(c =>
      c.open !== null &&
      c.high !== null &&
      c.low !== null &&
      c.close !== null
    );
}


// ----------------------------------------------------
// ATR
// ----------------------------------------------------

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - previous.close),
      Math.abs(c.low - previous.close)
    );

    trs.push(tr);
  }

  if (trs.length < period) {
    return null;
  }

  const recent = trs.slice(-period);

  return recent.reduce(
    (sum, value) => sum + value,
    0
  ) / recent.length;
}


// ----------------------------------------------------
// SWING
// ----------------------------------------------------

function isSwingHigh(candles, i) {
  const left = CONFIG.swingLeft;
  const right = CONFIG.swingRight;

  if (
    i - left < 0 ||
    i + right >= candles.length
  ) {
    return false;
  }

  const high = candles[i].high;

  for (
    let j = i - left;
    j <= i + right;
    j++
  ) {
    if (j === i) continue;

    if (candles[j].high > high) {
      return false;
    }
  }

  return true;
}


function isSwingLow(candles, i) {
  const left = CONFIG.swingLeft;
  const right = CONFIG.swingRight;

  if (
    i - left < 0 ||
    i + right >= candles.length
  ) {
    return false;
  }

  const low = candles[i].low;

  for (
    let j = i - left;
    j <= i + right;
    j++
  ) {
    if (j === i) continue;

    if (candles[j].low < low) {
      return false;
    }
  }

  return true;
}


// ----------------------------------------------------
// CLUSTER ZONE
// ----------------------------------------------------

function clusterLevels(levels, tolerance) {
  if (!levels.length) {
    return [];
  }

  const sorted = [...levels].sort(
    (a, b) => a.price - b.price
  );

  const clusters = [];

  for (const item of sorted) {
    let target = null;

    for (const cluster of clusters) {
      if (
        Math.abs(item.price - cluster.price) <= tolerance
      ) {
        target = cluster;
        break;
      }
    }

    if (!target) {
      clusters.push({
        price: item.price,
        count: 1,
        touches: [item]
      });
    } else {
      target.touches.push(item);

      target.count =
        target.touches.length;

      target.price =
        target.touches.reduce(
          (sum, x) => sum + x.price,
          0
        ) / target.touches.length;
    }
  }

  return clusters;
}


// ----------------------------------------------------
// BUILD ZONES
// ----------------------------------------------------

function buildZones(candles, atr) {
  if (!atr || !Number.isFinite(atr)) {
    return [];
  }

  const tolerance =
    atr * CONFIG.zoneAtrMult;

  const levels = [];

  for (
    let i = CONFIG.swingLeft;
    i < candles.length - CONFIG.swingRight;
    i++
  ) {
    if (isSwingHigh(candles, i)) {
      levels.push({
        type: "resistance",
        price: candles[i].high,
        index: i
      });
    }

    if (isSwingLow(candles, i)) {
      levels.push({
        type: "support",
        price: candles[i].low,
        index: i
      });
    }
  }

  const supports =
    levels.filter(x => x.type === "support");

  const resistances =
    levels.filter(x => x.type === "resistance");

  const zones = [];

  for (
    const cluster of clusterLevels(
      supports,
      tolerance
    )
  ) {
    if (cluster.count < CONFIG.minTests) {
      continue;
    }

    zones.push({
      type: "support",
      center: cluster.price,
      low: cluster.price - tolerance,
      high: cluster.price + tolerance,
      tests: cluster.count
    });
  }

  for (
    const cluster of clusterLevels(
      resistances,
      tolerance
    )
  ) {
    if (cluster.count < CONFIG.minTests) {
      continue;
    }

    zones.push({
      type: "resistance",
      center: cluster.price,
      low: cluster.price - tolerance,
      high: cluster.price + tolerance,
      tests: cluster.count
    });
  }

  return zones;
}


// ----------------------------------------------------
// REAZIONE CANDELA
// ----------------------------------------------------

function candleReaction(candles, zone) {
  if (candles.length < 2) {
    return "neutral";
  }

  const last =
    candles[candles.length - 1];

  const body =
    Math.abs(last.close - last.open);

  const range =
    Math.max(last.high - last.low, 1e-12);

  if (zone.type === "support") {
    const touched =
      last.low <= zone.high &&
      last.high >= zone.low;

    const bullish =
      last.close > last.open &&
      last.close >= zone.center &&
      body / range >= 0.25;

    if (touched && bullish) {
      return "bullish";
    }

    if (touched) {
      return "touch";
    }
  }

  if (zone.type === "resistance") {
    const touched =
      last.high >= zone.low &&
      last.low <= zone.high;

    const bearish =
      last.close < last.open &&
      last.close <= zone.center &&
      body / range >= 0.25;

    if (touched && bearish) {
      return "bearish";
    }

    if (touched) {
      return "touch";
    }
  }

  return "neutral";
}


// ----------------------------------------------------
// ANALISI TIMEFRAME
// ----------------------------------------------------

function analyzeTimeframe(
  symbol,
  interval,
  candles
) {
  const atr =
    calculateATR(candles);

  const decimals =
    decimalsForSymbol(symbol);

  const last =
    candles[candles.length - 1];

  if (!atr) {
    return {
      timeframe: interval,
      state: "ATTESA",
      direction: null,
      entry: null,
      zone: null,
      tests: 0,
      atr: null,
      reaction: "neutral"
    };
  }

  const zones =
    buildZones(candles, atr);

  if (!zones.length) {
    return {
      timeframe: interval,
      state: "ATTESA",
      direction: null,
      entry: null,
      zone: null,
      tests: 0,
      atr: roundPrice(atr, decimals),
      reaction: "neutral"
    };
  }

  const candidates =
    zones
      .map(zone => {

        const distance =
          last.close < zone.low
            ? zone.low - last.close
            : last.close > zone.high
              ? last.close - zone.high
              : 0;

        return {
          ...zone,
          distance,
          reaction:
            candleReaction(
              candles,
              zone
            )
        };
      })
      .sort(
        (a, b) =>
          a.distance - b.distance
      );

  const zone =
    candidates[0];

  const approachDistance =
    atr * CONFIG.approachAtrMult;

  let state = "ATTESA";
  let direction = null;

  if (zone.type === "support") {

    direction = "BUY";

    if (zone.reaction === "bullish") {
      state = "BUY";
    }
    else if (
      zone.distance <= approachDistance
    ) {
      state = "IN AVVICINAMENTO";
    }
  }

  if (zone.type === "resistance") {

    direction = "SELL";

    if (zone.reaction === "bearish") {
      state = "SELL";
    }
    else if (
      zone.distance <= approachDistance
    ) {
      state = "IN AVVICINAMENTO";
    }
  }

  return {
    timeframe: interval,

    state,

    direction,

    entry:
      state === "BUY" ||
      state === "SELL"
        ? roundPrice(
            last.close,
            decimals
          )
        : null,

    zone: {
      type: zone.type,

      low:
        roundPrice(
          zone.low,
          decimals
        ),

      high:
        roundPrice(
          zone.high,
          decimals
        ),

      tests: zone.tests
    },

    tests: zone.tests,

    atr:
      roundPrice(
        atr,
        decimals
      ),

    reaction:
      zone.reaction
  };
}


// ----------------------------------------------------
// SL / TP AUTOMATICI
// ----------------------------------------------------

function calculateAutomaticLevels(
  symbol,
  direction,
  entry,
  zone,
  atr
) {
  const decimals =
    decimalsForSymbol(symbol);

  if (
    !Number.isFinite(entry) ||
    !zone ||
    !Number.isFinite(atr)
  ) {
    return {
      entry: null,
      sl: null,
      tp: null,
      rr: CONFIG.rr
    };
  }

  const zoneWidth =
    Math.max(
      zone.high - zone.low,
      atr * CONFIG.zoneAtrMult
    );

  const buffer =
    atr * CONFIG.stopBufferAtrMult;

  /*
    SL volutamente non stretto.

    Prendiamo la distanza maggiore tra:
    - ATR
    - ampiezza della zona

    e aggiungiamo un piccolo buffer.
  */

  let stopDistance =
    Math.max(
      atr * CONFIG.stopAtrMult,
      zoneWidth * CONFIG.stopZoneMult
    );

  stopDistance += buffer;

  let sl;
  let tp;

  if (direction === "BUY") {

    const zoneProtection =
      zone.low - buffer;

    sl =
      Math.min(
        entry - stopDistance,
        zoneProtection
      );

    stopDistance =
      entry - sl;

    tp =
      entry +
      stopDistance * CONFIG.rr;
  }

  else {

    const zoneProtection =
      zone.high + buffer;

    sl =
      Math.max(
        entry + stopDistance,
        zoneProtection
      );

    stopDistance =
      sl - entry;

    tp =
      entry -
      stopDistance * CONFIG.rr;
  }

  return {
    entry:
      roundPrice(
        entry,
        decimals
      ),

    sl:
      roundPrice(
        sl,
        decimals
      ),

    tp:
      roundPrice(
        tp,
        decimals
      ),

    rr: CONFIG.rr
  };
}


// ----------------------------------------------------
// CONFRONTO TIMEFRAME
// ----------------------------------------------------

function combineTimeframes(
  timeframeResults
) {
  const buys =
    timeframeResults.filter(
      x => x.state === "BUY"
    );

  const sells =
    timeframeResults.filter(
      x => x.state === "SELL"
    );

  // Servono almeno 2 timeframe concordi.
  if (buys.length >= 2) {

    const selected =
      buys.find(
        x => x.timeframe === "15min"
      ) ||
      buys.find(
        x => x.timeframe === "1h"
      ) ||
      buys[0];

    return {
      state: "BUY",
      direction: "BUY",
      selected
    };
  }

  if (sells.length >= 2) {

    const selected =
      sells.find(
        x => x.timeframe === "15min"
      ) ||
      sells.find(
        x => x.timeframe === "1h"
      ) ||
      sells[0];

    return {
      state: "SELL",
      direction: "SELL",
      selected
    };
  }

  const approach =
    timeframeResults.find(
      x =>
        x.state ===
        "IN AVVICINAMENTO"
    );

  if (approach) {

    return {
      state: "IN AVVICINAMENTO",
      direction:
        approach.direction,
      selected: approach
    };
  }

  return {
    state: "ATTESA",
    direction: null,
    selected: null
  };
}


// ----------------------------------------------------
// SCAN SINGOLO STRUMENTO
// ----------------------------------------------------

async function scanSymbol(symbol) {

  const timeframeResults = [];

  for (
    const interval of INTERVALS
  ) {

    try {

      const candles =
        await getTimeSeries(
          symbol,
          interval
        );

      const result =
        analyzeTimeframe(
          symbol,
          interval,
          candles
        );

      timeframeResults.push(
        result
      );

    } catch (error) {

      timeframeResults.push({
        timeframe: interval,
        state: "ATTESA",
        direction: null,
        entry: null,
        zone: null,
        tests: 0,
        atr: null,
        reaction: "error",
        error: error.message
      });
    }
  }

  const combined =
    combineTimeframes(
      timeframeResults
    );

  const selected =
    combined.selected;

  let levels = {
    entry: null,
    sl: null,
    tp: null,
    rr: CONFIG.rr
  };

  if (
    selected &&
    (
      combined.state === "BUY" ||
      combined.state === "SELL"
    ) &&
    selected.entry !== null &&
    selected.zone &&
    selected.atr !== null
  ) {

    levels =
      calculateAutomaticLevels(
        symbol,
        combined.direction,
        selected.entry,
        selected.zone,
        selected.atr
      );
  }

  return {

    symbol,

    state:
      combined.state,

    direction:
      combined.direction,

    entry:
      levels.entry,

    zone:
      selected?.zone || null,

    sl:
      levels.sl,

    tp:
      levels.tp,

    rr:
      levels.rr,

    tests:
      selected?.tests || 0,

    timeframe:
      selected?.timeframe || null,

    timeframes:
      timeframeResults
  };
}


// ----------------------------------------------------
// SCANSIONE COMPLETA
// ----------------------------------------------------

async function runScan() {

  // Evita due scansioni contemporanee.
  if (scanPromise) {
    return scanPromise;
  }

  scanPromise =
    (async () => {

      const results = [];

      for (
        const symbol of SYMBOLS
      ) {

        const result =
          await scanSymbol(
            symbol
          );

        results.push(
          result
        );
      }

      lastScan = {

        status: "online",

        updatedAt:
          new Date().toISOString(),

        config: {
          minTests:
            CONFIG.minTests,

          rr:
            CONFIG.rr,

          refreshSeconds: 60
        },

        signals:
          results
      };

      lastScanAt =
        Date.now();

      return lastScan;
    })();

  try {
    return await scanPromise;
  }

  finally {
    scanPromise = null;
  }
}


// ----------------------------------------------------
// ENDPOINT
// ----------------------------------------------------

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service:
        "Market Sentinel Engine",
      updatedAt:
        lastScan?.updatedAt ||
        null
    });
  }
);


app.get(
  "/",
  (req, res) => {

    res.json({
      ok: true,
      service:
        "Market Sentinel Engine",
      message:
        "Scanner online"
    });
  }
);


// Endpoint principale
app.get(
  "/api/signals",
  async (req, res) => {

    try {

      if (
        !lastScan ||
        Date.now() - lastScanAt >=
          CACHE_MS
      ) {

        const scan =
          await runScan();

        return res.json(
          scan
        );
      }

      return res.json(
        lastScan
      );

    } catch (error) {

      console.error(
        "SCAN ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Errore scanner"
      });
    }
  }
);


// Refresh manuale
app.get(
  "/api/refresh",
  async (req, res) => {

    try {

      const scan =
        await runScan();

      res.json(
        scan
      );

    } catch (error) {

      console.error(
        "REFRESH ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Errore refresh"
      });
    }
  }
);


// ----------------------------------------------------
// START
// ----------------------------------------------------

app.listen(
  PORT,
  () => {

    console.log(
      `Market Sentinel Engine online on port ${PORT}`
    );

    if (!TWELVE_DATA_API_KEY) {

      console.warn(
        "ATTENZIONE: TWELVE_DATA_API_KEY non configurata."
      );
    }
  }
);
