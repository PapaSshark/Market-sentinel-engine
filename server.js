const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

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

const INTERVALS = [
  "5min",
  "15min",
  "1h"
];

const CONFIG = {
  bars: 250,

  minTests: 2,

  rr: 2,

  riskPct: 2,

  zoneAtrMult: 0.35,

  approachAtrMult: 1.5,

  swingLeft: 3,

  swingRight: 3
};

const CACHE_MS = 5 * 60 * 1000;
const PRICE_CACHE_MS = 30 * 1000;

let lastScan = {
  status: "starting",
  updatedAt: null,
  signals: []
};

let hasValidScan = false;

const seriesCache = new Map();
const priceCache = new Map();


// ============================================================
// UTILS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function roundPrice(value, symbol) {

  if (!Number.isFinite(value)) {
    return null;
  }

  if (symbol === "XAU/USD") {
    return Number(value.toFixed(2));
  }

  if (value < 10) {
    return Number(value.toFixed(5));
  }

  return Number(value.toFixed(3));
}


// ============================================================
// ATR
// ============================================================

function calculateATR(bars, period = 14) {

  if (!bars || bars.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < bars.length; i++) {

    const current = bars[i];
    const previous = bars[i - 1];

    const high = Number(current.high);
    const low = Number(current.low);
    const previousClose = Number(previous.close);

    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(previousClose)
    ) {
      continue;
    }

    const tr = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
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


// ============================================================
// SWING HIGH / LOW
// ============================================================

function findSwings(bars) {

  const left = CONFIG.swingLeft;
  const right = CONFIG.swingRight;

  const highs = [];
  const lows = [];

  for (
    let i = left;
    i < bars.length - right;
    i++
  ) {

    const currentHigh = Number(bars[i].high);
    const currentLow = Number(bars[i].low);

    if (
      !Number.isFinite(currentHigh) ||
      !Number.isFinite(currentLow)
    ) {
      continue;
    }

    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j <= i + right; j++) {

      if (j === i) {
        continue;
      }

      if (Number(bars[j].high) >= currentHigh) {
        isHigh = false;
      }

      if (Number(bars[j].low) <= currentLow) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: currentHigh
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: currentLow
      });
    }
  }

  return {
    highs,
    lows
  };
}


// ============================================================
// ZONE CREATION
// ============================================================

function buildZones(points, atr) {

  if (!points.length || !Number.isFinite(atr)) {
    return [];
  }

  const maxDistance =
    atr * CONFIG.zoneAtrMult;

  const sorted = [...points].sort(
    (a, b) => a.price - b.price
  );

  const clusters = [];

  for (const point of sorted) {

    let cluster = null;

    for (const existing of clusters) {

      if (
        Math.abs(
          point.price - existing.center
        ) <= maxDistance
      ) {
        cluster = existing;
        break;
      }
    }

    if (!cluster) {

      clusters.push({
        center: point.price,
        points: [point]
      });

    } else {

      cluster.points.push(point);

      cluster.center =
        cluster.points.reduce(
          (sum, p) => sum + p.price,
          0
        ) / cluster.points.length;
    }
  }

  return clusters
    .filter(
      cluster =>
        cluster.points.length >= CONFIG.minTests
    )
    .map(cluster => {

      const prices =
        cluster.points.map(p => p.price);

      return {
        center: cluster.center,
        low: Math.min(...prices) - maxDistance,
        high: Math.max(...prices) + maxDistance,
        tests: cluster.points.length
      };
    });
}


// ============================================================
// NEAREST ZONE
// ============================================================

function findNearestZone(
  zones,
  price,
  type
) {

  if (!zones.length) {
    return null;
  }

  const filtered = zones.filter(zone => {

    if (type === "support") {
      return zone.center <= price;
    }

    return zone.center >= price;
  });

  if (!filtered.length) {
    return null;
  }

  filtered.sort(
    (a, b) =>
      Math.abs(a.center - price) -
      Math.abs(b.center - price)
  );

  return filtered[0];
}


// ============================================================
// TECHNICAL ANALYSIS
// ============================================================

function analyze(
  symbol,
  bars,
  interval,
  livePrice
) {

  if (!bars || bars.length < 30) {

    return {
      interval,
      status: "ERROR",
      direction: "ERROR",
      message: "Dati insufficienti"
    };
  }

  const atr =
    calculateATR(bars, 14);

  if (!Number.isFinite(atr) || atr <= 0) {

    return {
      interval,
      status: "ERROR",
      direction: "ERROR",
      message: "ATR non disponibile"
    };
  }

  const swings =
    findSwings(bars);

  const supportZones =
    buildZones(swings.lows, atr);

  const resistanceZones =
    buildZones(swings.highs, atr);

  const last =
    bars[bars.length - 1];

  const previous =
    bars[bars.length - 2];

  const price =
    Number.isFinite(livePrice)
      ? livePrice
      : Number(last.close);

  const open = Number(last.open);
  const high = Number(last.high);
  const low = Number(last.low);
  const close = Number(last.close);

  const previousHigh =
    Number(previous.high);

  const previousLow =
    Number(previous.low);


  // ----------------------------------------------------------
  // SUPPORT
  // ----------------------------------------------------------

  const support =
    findNearestZone(
      supportZones,
      price,
      "support"
    );


  // ----------------------------------------------------------
  // RESISTANCE
  // ----------------------------------------------------------

  const resistance =
    findNearestZone(
      resistanceZones,
      price,
      "resistance"
    );


  // ----------------------------------------------------------
  // DISTANZA DALLE ZONE
  // ----------------------------------------------------------

  const supportDistance =
    support
      ? Math.abs(price - support.center)
      : Infinity;

  const resistanceDistance =
    resistance
      ? Math.abs(price - resistance.center)
      : Infinity;


  const approachDistance =
    atr * CONFIG.approachAtrMult;


  // ----------------------------------------------------------
  // CANDELA
  // ----------------------------------------------------------

  const bullish =
    close > open;

  const bearish =
    close < open;


  // ----------------------------------------------------------
  // BUY CONDITIONS
  // ----------------------------------------------------------

  let buySignal = false;

  if (support) {

    const supportRejection =
      low <= support.high &&
      bullish;

    const bullishBreak =
      close > previousHigh;

    if (
      supportRejection ||
      bullishBreak
    ) {
      buySignal = true;
    }
  }


  // ----------------------------------------------------------
  // SELL CONDITIONS
  // ----------------------------------------------------------

  let sellSignal = false;

  if (resistance) {

    const resistanceRejection =
      high >= resistance.low &&
      bearish;

    const bearishBreak =
      close < previousLow;

    if (
      resistanceRejection ||
      bearishBreak
    ) {
      sellSignal = true;
    }
  }


  // ----------------------------------------------------------
  // BUY
  // ----------------------------------------------------------

  if (buySignal && support) {

    const entry = price;

    const sl =
      support.low -
      atr * 0.15;

    const risk =
      entry - sl;

    const tp =
      entry +
      risk * CONFIG.rr;

    return {
      interval,
      status: "SIGNAL",
      direction: "BUY",

      price: roundPrice(price, symbol),

      entry: roundPrice(entry, symbol),

      zone: {
        type: "SUPPORT",
        low: roundPrice(support.low, symbol),
        high: roundPrice(support.high, symbol),
        tests: support.tests
      },

      sl: roundPrice(sl, symbol),

      tp: roundPrice(tp, symbol),

      rr: CONFIG.rr,

      atr: roundPrice(atr, symbol),

      distanceToZone:
        roundPrice(
          supportDistance,
          symbol
        )
    };
  }


  // ----------------------------------------------------------
  // SELL
  // ----------------------------------------------------------

  if (sellSignal && resistance) {

    const entry = price;

    const sl =
      resistance.high +
      atr * 0.15;

    const risk =
      sl - entry;

    const tp =
      entry -
      risk * CONFIG.rr;

    return {
      interval,
      status: "SIGNAL",
      direction: "SELL",

      price: roundPrice(price, symbol),

      entry: roundPrice(entry, symbol),

      zone: {
        type: "RESISTANCE",
        low: roundPrice(resistance.low, symbol),
        high: roundPrice(resistance.high, symbol),
        tests: resistance.tests
      },

      sl: roundPrice(sl, symbol),

      tp: roundPrice(tp, symbol),

      rr: CONFIG.rr,

      atr: roundPrice(atr, symbol),

      distanceToZone:
        roundPrice(
          resistanceDistance,
          symbol
        )
    };
  }


  // ----------------------------------------------------------
  // APPROACH
  // ----------------------------------------------------------

  const closestDistance =
    Math.min(
      supportDistance,
      resistanceDistance
    );


  if (
    Number.isFinite(closestDistance) &&
    closestDistance <= approachDistance
  ) {

    const closestZone =
      supportDistance <= resistanceDistance
        ? support
        : resistance;

    return {
      interval,
      status: "APPROACH",
      direction: "WAIT",

      price: roundPrice(price, symbol),

      zone: closestZone
        ? {
            type:
              supportDistance <= resistanceDistance
                ? "SUPPORT"
                : "RESISTANCE",

            low:
              roundPrice(
                closestZone.low,
                symbol
              ),

            high:
              roundPrice(
                closestZone.high,
                symbol
              ),

            tests:
              closestZone.tests
          }
        : null,

      atr: roundPrice(atr, symbol),

      distanceToZone:
        roundPrice(
          closestDistance,
          symbol
        )
    };
  }


  // ----------------------------------------------------------
  // WAIT
  // ----------------------------------------------------------

  return {
    interval,
    status: "WAIT",
    direction: "WAIT",

    price: roundPrice(price, symbol),

    zone: null,

    atr: roundPrice(atr, symbol),

    distanceToZone:
      Number.isFinite(closestDistance)
        ? roundPrice(
            closestDistance,
            symbol
          )
        : null
  };
}


// ============================================================
// TWELVE DATA - TIME SERIES
// ============================================================

async function getSeries(
  symbol,
  interval
) {

  const cacheKey =
    `${symbol}_${interval}`;

  const cached =
    seriesCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.timestamp < CACHE_MS
  ) {

    return cached.data;
  }


  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY mancante"
    );
  }


  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${CONFIG.bars}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;


  const response =
    await fetch(url);


  if (!response.ok) {

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }


  const data =
    await response.json();


  if (
    data.status === "error" ||
    !data.values
  ) {

    throw new Error(
      data.message ||
      "Twelve Data: dati non disponibili"
    );
  }


  const bars =
    data.values
      .map(item => ({
        datetime: item.datetime,
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close)
      }))
      .filter(item =>
        Number.isFinite(item.open) &&
        Number.isFinite(item.high) &&
        Number.isFinite(item.low) &&
        Number.isFinite(item.close)
      )
      .reverse();


  if (bars.length < 30) {

    throw new Error(
      `Dati insufficienti per ${symbol} ${interval}`
    );
  }


  seriesCache.set(
    cacheKey,
    {
      timestamp: Date.now(),
      data: bars
    }
  );


  return bars;
}


// ============================================================
// TWELVE DATA - PREZZO REALE
// ============================================================

async function getLivePrice(symbol) {

  const cached =
    priceCache.get(symbol);

  if (
    cached &&
    Date.now() - cached.timestamp <
      PRICE_CACHE_MS
  ) {

    return cached.data;
  }


  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY mancante"
    );
  }


  const url =
    "https://api.twelvedata.com/price" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;


  const response =
    await fetch(url);


  if (!response.ok) {

    throw new Error(
      `Twelve Data price HTTP ${response.status}`
    );
  }


  const data =
    await response.json();


  const price =
    Number(data.price);


  if (!Number.isFinite(price)) {

    throw new Error(
      data.message ||
      "Prezzo reale non disponibile"
    );
  }


  const result = {
    price,
    source: "Twelve Data /price",
    updatedAt: new Date().toISOString()
  };


  priceCache.set(
    symbol,
    {
      timestamp: Date.now(),
      data: result
    }
  );


  return result;
}


// ============================================================
// COMBINAZIONE TIMEFRAME
// ============================================================

function combineTimeframes(
  symbol,
  timeframeResults,
  livePrice
) {

  const buys =
    timeframeResults.filter(
      x =>
        x.status === "SIGNAL" &&
        x.direction === "BUY"
    );

  const sells =
    timeframeResults.filter(
      x =>
        x.status === "SIGNAL" &&
        x.direction === "SELL"
    );


  // ----------------------------------------------------------
  // 2 TIMEFRAME BUY
  // ----------------------------------------------------------

  if (
    buys.length >= 2 &&
    sells.length === 0
  ) {

    const selected =
      buys.find(
        x => x.interval === "15min"
      ) ||
      buys.find(
        x => x.interval === "1h"
      ) ||
      buys[0];


    return {
      status: "SIGNAL",
      direction: "BUY",

      price:
        roundPrice(
          livePrice,
          symbol
        ),

      entry: selected.entry,

      zone: selected.zone,

      sl: selected.sl,

      tp: selected.tp,

      rr: selected.rr,

      atr: selected.atr,

      signalTimeframe:
        selected.interval,

      confirmation:
        buys.map(x => x.interval)
    };
  }


  // ----------------------------------------------------------
  // 2 TIMEFRAME SELL
  // ----------------------------------------------------------

  if (
    sells.length >= 2 &&
    buys.length === 0
  ) {

    const selected =
      sells.find(
        x => x.interval === "15min"
      ) ||
      sells.find(
        x => x.interval === "1h"
      ) ||
      sells[0];


    return {
      status: "SIGNAL",
      direction: "SELL",

      price:
        roundPrice(
          livePrice,
          symbol
        ),

      entry: selected.entry,

      zone: selected.zone,

      sl: selected.sl,

      tp: selected.tp,

      rr: selected.rr,

      atr: selected.atr,

      signalTimeframe:
        selected.interval,

      confirmation:
        sells.map(x => x.interval)
    };
  }


  // ----------------------------------------------------------
  // CONFLITTO
  // ----------------------------------------------------------

  if (
    buys.length > 0 &&
    sells.length > 0
  ) {

    return {
      status: "CONFLICT",
      direction: "WAIT",

      price:
        roundPrice(
          livePrice,
          symbol
        ),

      message:
        "Timeframe in conflitto"
    };
  }


  // ----------------------------------------------------------
  // APPROACH
  // ----------------------------------------------------------

  const approaches =
    timeframeResults.filter(
      x => x.status === "APPROACH"
    );


  if (approaches.length > 0) {

    const selected =
      approaches.find(
        x => x.interval === "15min"
      ) ||
      approaches.find(
        x => x.interval === "1h"
      ) ||
      approaches[0];


    return {
      status: "APPROACH",
      direction: "WAIT",

      price:
        roundPrice(
          livePrice,
          symbol
        ),

      zone: selected.zone || null,

      signalTimeframe:
        selected.interval
    };
  }


  // ----------------------------------------------------------
  // WAIT
  // ----------------------------------------------------------

  return {
    status: "WAIT",
    direction: "WAIT",

    price:
      roundPrice(
        livePrice,
        symbol
      )
  };
}


// ============================================================
// SCAN SINGOLO MERCATO
// ============================================================

async function scanSymbol(symbol) {

  let livePrice = null;
  let priceInfo = null;
  let priceError = null;


  // ----------------------------------------------------------
  // PREZZO REALE
  // ----------------------------------------------------------

  try {

    priceInfo =
      await getLivePrice(symbol);

    livePrice =
      Number(priceInfo.price);

  } catch (error) {

    priceError =
      error.message;

    console.error(
      `Prezzo ${symbol}:`,
      error.message
    );
  }


  const timeframeResults = [];

  const errors = [];


  // ----------------------------------------------------------
  // TIMEFRAME
  // ----------------------------------------------------------

  for (const interval of INTERVALS) {

    try {

      const bars =
        await getSeries(
          symbol,
          interval
        );


      const result =
        analyze(
          symbol,
          bars,
          interval,
          livePrice
        );


      timeframeResults.push(result);

    } catch (error) {

      console.error(
        `${symbol} ${interval}:`,
        error.message
      );

      errors.push({
        interval,
        message: error.message
      });

      timeframeResults.push({
        interval,
        status: "ERROR",
        direction: "ERROR",
        message: error.message
      });
    }

    await sleep(100);
  }


  // ----------------------------------------------------------
  // RISULTATO FINALE
  // ----------------------------------------------------------

  const combined =
    combineTimeframes(
      symbol,
      timeframeResults,
      livePrice
    );


  return {

    symbol,

    ...combined,

    livePrice:
      Number.isFinite(livePrice)
        ? roundPrice(
            livePrice,
            symbol
          )
        : null,

    priceSource:
      priceInfo
        ? priceInfo.source
        : null,

    priceUpdatedAt:
      priceInfo
        ? priceInfo.updatedAt
        : null,

    priceError,

    diagnostics: {
      errors,
      timeframesChecked:
        INTERVALS
    },

    timeframes:
      timeframeResults
  };
}


// ============================================================
// SCAN TUTTI I MERCATI
// ============================================================

async function scanAll(
  force = false
) {

  if (
    !force &&
    hasValidScan &&
    lastScan.updatedAt &&
    Date.now() -
      new Date(lastScan.updatedAt).getTime()
      < CACHE_MS
  ) {

    return lastScan;
  }


  lastScan = {
    status: "scanning",
    updatedAt: new Date().toISOString(),
    signals: []
  };


  const results = [];


  for (const symbol of SYMBOLS) {

    try {

      const result =
        await scanSymbol(symbol);

      results.push(result);

    } catch (error) {

      console.error(
        `Errore ${symbol}:`,
        error.message
      );

      results.push({
        symbol,

        status: "ERROR",

        direction: "ERROR",

        message:
          error.message,

        price: null,

        livePrice: null
      });
    }
  }


  lastScan = {

    status: "online",

    updatedAt:
      new Date().toISOString(),

    config: CONFIG,

    signals: results
  };


  hasValidScan = true;


  return lastScan;
}


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {

  res.json({
    ok: true,
    status: "online",
    service: "Market Sentinel Engine",
    updatedAt: lastScan.updatedAt
  });

});


// ============================================================
// SIGNALS
// ============================================================

app.get(
  "/api/signals",
  async (req, res) => {

    try {

      const result =
        await scanAll(false);

      res.json(result);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);


// ============================================================
// FORCE REFRESH
// ============================================================

app.get(
  "/api/refresh",
  async (req, res) => {

    try {

      const result =
        await scanAll(true);

      res.json(result);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);


// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {

  res.json({

    service:
      "Market Sentinel Engine",

    status:
      lastScan.status,

    message:
      "Server online",

    markets:
      SYMBOLS,

    intervals:
      INTERVALS
  });

});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `Market Sentinel Engine online on port ${PORT}`
  );

});
