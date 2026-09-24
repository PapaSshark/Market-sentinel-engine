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

const INTERVALS = ["5min", "15min", "1h"];

const CONFIG = {
  bars: 250,
  minTests: 2,
  rr: 2,
  riskPct: 1,
  zoneAtrMult: 0.35,
  approachAtrMult: 1.5,
  swingLeft: 3,
  swingRight: 3
};

let USER_SETTINGS = {
  riskPct: 1,
  rr: 2
};

let lastScan = null;
let lastScanAt = 0;

const CACHE_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function roundPrice(price) {
  if (!Number.isFinite(price)) return null;

  if (price >= 100) return Number(price.toFixed(2));
  if (price >= 10) return Number(price.toFixed(3));
  return Number(price.toFixed(5));
}

function normalizeSymbol(symbol) {
  return symbol.replace("/", "");
}

async function tdRequest(endpoint, params = {}) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY mancante");
  }

  const url = new URL(
    `https://api.twelvedata.com/${endpoint}`
  );

  url.searchParams.set("apikey", API_KEY);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message || "Errore Twelve Data"
    );
  }

  return data;
}

async function getSeries(symbol, interval) {
  const data = await tdRequest("time_series", {
    symbol,
    interval,
    outputsize: CONFIG.bars,
    format: "JSON"
  });

  if (!data.values || !Array.isArray(data.values)) {
    throw new Error(`Nessun dato per ${symbol} ${interval}`);
  }

  return data.values
    .map(row => ({
      datetime: row.datetime,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close)
    }))
    .filter(row =>
      Number.isFinite(row.open) &&
      Number.isFinite(row.high) &&
      Number.isFinite(row.low) &&
      Number.isFinite(row.close)
    )
    .reverse();
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);

  if (!recent.length) return null;

  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function findSwings(candles) {
  const highs = [];
  const lows = [];

  const left = CONFIG.swingLeft;
  const right = CONFIG.swingRight;

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= current.high) {
        isHigh = false;
      }

      if (candles[i - j].low <= current.low) {
        isLow = false;
      }
    }

    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > current.high) {
        isHigh = false;
      }

      if (candles[i + j].low < current.low) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push({
        price: current.high,
        index: i
      });
    }

    if (isLow) {
      lows.push({
        price: current.low,
        index: i
      });
    }
  }

  return {
    highs,
    lows
  };
}

function clusterZones(points, tolerance) {
  if (!points.length) return [];

  const sorted = [...points].sort(
    (a, b) => a - b
  );

  const zones = [];

  for (const price of sorted) {
    let zone = zones.find(
      z => Math.abs(z.center - price) <= tolerance
    );

    if (!zone) {
      zones.push({
        center: price,
        prices: [price]
      });
    } else {
      zone.prices.push(price);

      zone.center =
        zone.prices.reduce(
          (sum, value) => sum + value,
          0
        ) / zone.prices.length;
    }
  }

  return zones.map(zone => ({
    center: zone.center,
    tests: zone.prices.length
  }));
}

function getZones(candles, atr) {
  if (!atr) {
    return {
      supports: [],
      resistances: []
    };
  }

  const swings = findSwings(candles);

  const tolerance =
    atr * CONFIG.zoneAtrMult;

  const supports = clusterZones(
    swings.lows.map(x => x.price),
    tolerance
  ).filter(
    zone => zone.tests >= CONFIG.minTests
  );

  const resistances = clusterZones(
    swings.highs.map(x => x.price),
    tolerance
  ).filter(
    zone => zone.tests >= CONFIG.minTests
  );

  return {
    supports,
    resistances
  };
}

function findNearestSupport(supports, price) {
  const below = supports
    .filter(zone => zone.center < price)
    .sort(
      (a, b) => b.center - a.center
    );

  return below[0] || null;
}

function findNearestResistance(resistances, price) {
  const above = resistances
    .filter(zone => zone.center > price)
    .sort(
      (a, b) => a.center - b.center
    );

  return above[0] || null;
}

/*
  LOGICA RICHIESTA:

  riskPct:
  1 = SL base
  2 = SL 2x
  3 = SL 3x

  RR:
  2 = TP 2x distanza SL
  3 = TP 3x distanza SL
  4 = TP 4x distanza SL
*/

function calculateLevels(
  direction,
  entry,
  zone,
  atr,
  riskPct,
  rr
) {
  if (!Number.isFinite(entry)) {
    return {
      entry: null,
      zone: null,
      sl: null,
      tp: null,
      rr
    };
  }

  const baseDistance = Math.max(
    atr * 0.8,
    Math.abs(entry - zone) + atr * 0.15
  );

  const riskMultiplier =
    Math.max(1, Math.min(3, Number(riskPct) || 1));

  const slDistance =
    baseDistance * riskMultiplier;

  const tpDistance =
    slDistance * rr;

  let sl;
  let tp;

  if (direction === "BUY") {
    sl = entry - slDistance;
    tp = entry + tpDistance;
  } else {
    sl = entry + slDistance;
    tp = entry - tpDistance;
  }

  return {
    entry: roundPrice(entry),
    zone: roundPrice(zone),
    sl: roundPrice(sl),
    tp: roundPrice(tp),
    rr: Number(rr)
  };
}

function analyze(
  symbol,
  candles,
  interval,
  settings
) {
  if (!candles.length) {
    return {
      symbol,
      interval,
      status: "WAIT",
      reason: "Dati insufficienti"
    };
  }

  const price =
    candles[candles.length - 1].close;

  const atr = calculateATR(candles);

  if (!atr) {
    return {
      symbol,
      interval,
      status: "WAIT",
      reason: "ATR non disponibile",
      price: roundPrice(price)
    };
  }

  const zones = getZones(candles, atr);

  const support =
    findNearestSupport(
      zones.supports,
      price
    );

  const resistance =
    findNearestResistance(
      zones.resistances,
      price
    );

  const approachDistance =
    atr * CONFIG.approachAtrMult;

  /*
    BUY:
    prezzo vicino alla resistenza e la struttura
    mostra una possibile rottura.
  */

  if (
    resistance &&
    Math.abs(price - resistance.center) <=
      approachDistance
  ) {
    const distance =
      resistance.center - price;

    if (
      price >= resistance.center ||
      distance <= atr * 0.25
    ) {
      const levels = calculateLevels(
        "BUY",
        price,
        resistance.center,
        atr,
        settings.riskPct,
        settings.rr
      );

      return {
        symbol,
        interval,
        status: "SIGNAL",
        direction: "BUY",
        price: roundPrice(price),
        ...levels,
        atr: roundPrice(atr)
      };
    }

    return {
      symbol,
      interval,
      status: "APPROACH",
      direction: "BUY",
      price: roundPrice(price),
      zone: roundPrice(resistance.center),
      zoneType: "RESISTENZA",
      tests: resistance.tests,
      atr: roundPrice(atr)
    };
  }

  /*
    SELL:
    prezzo vicino al supporto e struttura
    mostra una possibile rottura.
  */

  if (
    support &&
    Math.abs(price - support.center) <=
      approachDistance
  ) {
    const distance =
      price - support.center;

    if (
      price <= support.center ||
      distance <= atr * 0.25
    ) {
      const levels = calculateLevels(
        "SELL",
        price,
        support.center,
        atr,
        settings.riskPct,
        settings.rr
      );

      return {
        symbol,
        interval,
        status: "SIGNAL",
        direction: "SELL",
        price: roundPrice(price),
        ...levels,
        atr: roundPrice(atr)
      };
    }

    return {
      symbol,
      interval,
      status: "APPROACH",
      direction: "SELL",
      price: roundPrice(price),
      zone: roundPrice(support.center),
      zoneType: "SUPPORTO",
      tests: support.tests,
      atr: roundPrice(atr)
    };
  }

  return {
    symbol,
    interval,
    status: "WAIT",
    price: roundPrice(price),
    atr: roundPrice(atr)
  };
}

function combineTimeframes(
  symbol,
  timeframeResults,
  settings
) {
  const buys =
    timeframeResults.filter(
      x => x.status === "SIGNAL" &&
           x.direction === "BUY"
    );

  const sells =
    timeframeResults.filter(
      x => x.status === "SIGNAL" &&
           x.direction === "SELL"
    );

  let selected = null;
  let direction = null;

  if (buys.length >= 2) {
    direction = "BUY";

    selected =
      buys.find(x => x.interval === "15min") ||
      buys.find(x => x.interval === "1h") ||
      buys[0];
  }

  if (sells.length >= 2) {
    direction = "SELL";

    selected =
      sells.find(x => x.interval === "15min") ||
      sells.find(x => x.interval === "1h") ||
      sells[0];
  }

  if (selected) {
    /*
      Ricalcolo SEMPRE i livelli usando le impostazioni
      attuali, così Salva impostazioni produce
      immediatamente nuovi SL/TP.
    */

    const levels = calculateLevels(
      direction,
      selected.entry,
      selected.zone,
      selected.atr,
      settings.riskPct,
      settings.rr
    );

    return {
      symbol,
      status: "SIGNAL",
      direction,
      entry: levels.entry,
      zone: levels.zone,
      sl: levels.sl,
      tp: levels.tp,
      rr: levels.rr,
      atr: selected.atr,
      signalTimeframe: selected.interval,
      confirmation:
        `${buys.length || sells.length}/3 timeframe`
    };
  }

  const approaches =
    timeframeResults.filter(
      x => x.status === "APPROACH"
    );

  if (approaches.length) {
    const selectedApproach =
      approaches.find(
        x => x.interval === "15min"
      ) ||
      approaches.find(
        x => x.interval === "1h"
      ) ||
      approaches[0];

    return {
      symbol,
      status: "APPROACH",
      direction:
        selectedApproach.direction || null,
      zone:
        selectedApproach.zone || null,
      zoneType:
        selectedApproach.zoneType || null,
      tests:
        selectedApproach.tests || 0
    };
  }

  return {
    symbol,
    status: "WAIT"
  };
}

async function scanMarket(
  symbol,
  settings
) {
  const timeframeResults = [];

  for (const interval of INTERVALS) {
    try {
      const candles =
        await getSeries(
          symbol,
          interval
        );

      const result =
        analyze(
          symbol,
          candles,
          interval,
          settings
        );

      timeframeResults.push(result);

      await sleep(150);
    } catch (error) {
      timeframeResults.push({
        symbol,
        interval,
        status: "WAIT",
        error: error.message
      });
    }
  }

  const finalResult =
    combineTimeframes(
      symbol,
      timeframeResults,
      settings
    );

  return {
    symbol,
    ...finalResult,
    timeframes: timeframeResults
  };
}

async function runScan(settings = USER_SETTINGS) {
  const results = [];

  for (const symbol of SYMBOLS) {
    try {
      const result =
        await scanMarket(
          symbol,
          settings
        );

      results.push(result);
    } catch (error) {
      results.push({
        symbol,
        status: "ERROR",
        error: error.message
      });
    }

    await sleep(200);
  }

  lastScan = {
    status: "online",
    updatedAt:
      new Date().toISOString(),
    config: {
      ...CONFIG,
      riskPct: settings.riskPct,
      rr: settings.rr
    },
    settings: {
      riskPct: settings.riskPct,
      rr: settings.rr
    },
    signals: results
  };

  lastScanAt = Date.now();

  return lastScan;
}

/*
  GET SETTINGS
*/
app.get(
  "/api/settings",
  (req, res) => {
    res.json({
      ok: true,
      settings: USER_SETTINGS
    });
  }
);

/*
  SAVE SETTINGS + RECALCULATE IMMEDIATELY
*/
app.post(
  "/api/settings",
  async (req, res) => {
    try {
      const riskPct =
        Number(req.body.riskPct);

      const rr =
        Number(req.body.rr);

      if (
        ![1, 2, 3].includes(riskPct)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "riskPct deve essere 1, 2 oppure 3"
        });
      }

      if (
        ![2, 3, 4].includes(rr)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "rr deve essere 2, 3 oppure 4"
        });
      }

      USER_SETTINGS = {
        riskPct,
        rr
      };

      /*
        Forziamo il ricalcolo.
      */
      const result =
        await runScan(USER_SETTINGS);

      res.json({
        ok: true,
        settings: USER_SETTINGS,
        recalculated: true,
        data: result
      });
    } catch (error) {
      console.error(
        "Errore salvataggio impostazioni:",
        error
      );

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

/*
  GET SIGNALS
*/
app.get(
  "/api/signals",
  async (req, res) => {
    try {
      if (
        !lastScan ||
        Date.now() - lastScanAt > CACHE_MS
      ) {
        const result =
          await runScan(USER_SETTINGS);

        return res.json(result);
      }

      res.json(lastScan);
    } catch (error) {
      console.error(
        "Errore /api/signals:",
        error
      );

      res.status(500).json({
        status: "error",
        error: error.message
      });
    }
  }
);

/*
  FORCE REFRESH
*/
app.post(
  "/api/refresh",
  async (req, res) => {
    try {
      const result =
        await runScan(USER_SETTINGS);

      res.json(result);
    } catch (error) {
      console.error(
        "Errore refresh:",
        error
      );

      res.status(500).json({
        status: "error",
        error: error.message
      });
    }
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "Market Sentinel Engine"
    });
  }
);

app.get(
  "/",
  (req, res) => {
    res.send(
      "Market Sentinel Engine online"
    );
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Market Sentinel Engine online on port ${PORT}`
    );
  }
);
