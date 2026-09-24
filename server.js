
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const SYMBOLS = (
  process.env.SYMBOLS ||
  "EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD,NZD/USD,EUR/GBP,XAU/USD"
)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

/*
  ============================================================
  MARKET SENTINEL ENGINE
  ============================================================

  Timeframe utilizzati internamente:
  - 5 minuti
  - 15 minuti
  - 1 ora

  NON vengono esposti nelle impostazioni del sito.

  Il server analizza:
  - supporti
  - resistenze
  - numero di test della zona
  - ATR
  - reazione del prezzo
  - BUY / SELL
  - SL
  - TP
  - Risk/Reward
  - conferma multi-timeframe
*/

const INTERNAL_INTERVALS = ["5min", "15min", "1h"];

const CONFIG = {
  bars: Number(process.env.BARS || 250),

  // Numero minimo di test necessari per considerare valida una zona
  minTests: Number(process.env.MIN_TESTS || 2),

  // Risk / Reward
  rr: Number(process.env.RR || 2),

  // Rischio indicativo
  riskPct: Number(process.env.RISK_PCT || 2),

  // Ampiezza zona rispetto all'ATR
  zoneAtrMult: Number(process.env.ZONE_ATR_MULT || 0.35),

  // Swing
  swingLeft: 3,
  swingRight: 3
};

const CACHE_MS = 5 * 60 * 1000;

/*
  Stato iniziale.
  Alla prima richiesta /api/signals viene eseguita
  immediatamente una scansione completa.
*/

let lastScan = {
  status: "waiting",
  updatedAt: null,
  scanning: false,
  signals: []
};

let scanPromise = null;

/*
  ============================================================
  ATR
  ============================================================
*/

function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const previous = bars[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  const slice = trs.slice(-period);

  if (!slice.length) {
    return null;
  }

  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

/*
  ============================================================
  SWING HIGH / SWING LOW
  ============================================================
*/

function swings(bars) {
  const out = [];

  if (!Array.isArray(bars)) {
    return out;
  }

  for (
    let i = CONFIG.swingLeft;
    i < bars.length - CONFIG.swingRight;
    i++
  ) {
    const b = bars[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= CONFIG.swingLeft; j++) {
      if (bars[i - j].high >= b.high) {
        isHigh = false;
      }

      if (bars[i - j].low <= b.low) {
        isLow = false;
      }
    }

    for (let j = 1; j <= CONFIG.swingRight; j++) {
      if (bars[i + j].high >= b.high) {
        isHigh = false;
      }

      if (bars[i + j].low <= b.low) {
        isLow = false;
      }
    }

    if (isHigh) {
      out.push({
        type: "resistance",
        price: b.high,
        i
      });
    }

    if (isLow) {
      out.push({
        type: "support",
        price: b.low,
        i
      });
    }
  }

  return out;
}

/*
  ============================================================
  ZONE
  ============================================================
*/

function makeZones(bars) {
  const a = atr(bars);

  if (!a) {
    return [];
  }

  const tolerance = a * CONFIG.zoneAtrMult;
  const points = swings(bars);
  const zones = [];

  for (const point of points) {
    let zone = zones.find(
      z =>
        z.type === point.type &&
        Math.abs(z.center - point.price) <= tolerance
    );

    if (!zone) {
      zone = {
        type: point.type,
        center: point.price,
        prices: [],
        indices: [],
        tests: 0
      };

      zones.push(zone);
    }

    zone.prices.push(point.price);
    zone.indices.push(point.i);

    zone.center =
      zone.prices.reduce((sum, value) => sum + value, 0) /
      zone.prices.length;
  }

  for (const zone of zones) {
    zone.tests = zone.prices.length;

    zone.width = tolerance;

    zone.low = zone.center - tolerance / 2;
    zone.high = zone.center + tolerance / 2;

    const recency =
      zone.indices[zone.indices.length - 1] / bars.length;

    zone.score = Math.min(
      100,
      35 +
        zone.tests * 12 +
        Math.min(25, recency * 25)
    );

    zone.lastTest = Math.max(...zone.indices);
  }

  return zones
    .filter(zone => zone.tests >= CONFIG.minTests)
    .filter(zone => zone.lastTest >= bars.length * 0.35);
}

/*
  ============================================================
  ANALISI SINGOLO TIMEFRAME
  ============================================================
*/

function analyze(symbol, bars, interval) {
  if (!bars || !bars.length) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price: null,
      zones: []
    };
  }

  const current = bars[bars.length - 1].close;
  const a = atr(bars);
  const zones = makeZones(bars);

  if (!a || !zones.length) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price: current,
      zones: []
    };
  }

  /*
    Zona più vicina al prezzo attuale
  */

  const nearest = zones
    .map(zone => ({
      ...zone,
      distance: Math.abs(current - zone.center)
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  /*
    Distanza massima per considerare il prezzo
    vicino alla zona.
  */

  const approachDistance = a * 0.9;

  if (nearest.distance > approachDistance) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price: current,
      nearestZone: formatZone(nearest)
    };
  }

  /*
    Ultime candele
  */

  const recent = bars.slice(-3);

  if (recent.length < 2) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price: current,
      nearestZone: formatZone(nearest)
    };
  }

  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];

  let direction = null;
  let confirmation = false;

  /*
    SUPPORTO
    */

  if (nearest.type === "support") {
    const rejected =
      last.low <= nearest.high &&
      last.close > last.open;

    const bullishFollow =
      last.close > prev.high;

    if (rejected || bullishFollow) {
      direction = "BUY";
      confirmation = true;
    }
  }

  /*
    RESISTENZA
    */

  if (nearest.type === "resistance") {
    const rejected =
      last.high >= nearest.low &&
      last.close < last.open;

    const bearishFollow =
      last.close < prev.low;

    if (rejected || bearishFollow) {
      direction = "SELL";
      confirmation = true;
    }
  }

  /*
    Nessuna conferma
  */

  if (!confirmation) {
    return {
      symbol,
      interval,
      status: "APPROACH",
      price: current,
      nearestZone: formatZone(nearest)
    };
  }

  /*
    ==========================================================
    ENTRY / SL / TP
    ==========================================================
  */

  const entry = current;

  let sl;
  let tp;

  if (direction === "BUY") {
    sl = nearest.low - a * 0.15;
    tp = entry + (entry - sl) * CONFIG.rr;
  } else {
    sl = nearest.high + a * 0.15;
    tp = entry - (sl - entry) * CONFIG.rr;
  }

  return {
    symbol,
    interval,
    status: "SIGNAL",
    direction,

    price: current,

    zone: {
      type: nearest.type,
      low: nearest.low,
      high: nearest.high,
      tests: nearest.tests,
      score: Math.round(nearest.score)
    },

    entry,
    sl,
    tp,

    rr: CONFIG.rr,
    riskPct: CONFIG.riskPct,

    note:
      "Segnale tecnico basato su zona + reazione del prezzo. Nessun ordine automatico."
  };
}

/*
  ============================================================
  FORMAT ZONA
  ============================================================
*/

function formatZone(zone) {
  if (!zone) {
    return null;
  }

  return {
    type: zone.type,
    center: zone.center,
    low: zone.low,
    high: zone.high,
    tests: zone.tests,
    score: Math.round(zone.score),
    distance: zone.distance
  };
}

/*
  ============================================================
  TWELVE DATA
  ============================================================
*/

async function getSeries(symbol, interval) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY non configurata");
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set(
    "outputsize",
    String(CONFIG.bars)
  );
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `Data provider HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (data.status === "error") {
      throw new Error(
        data.message || "Errore provider"
      );
    }

    if (!data.values || !Array.isArray(data.values)) {
      throw new Error(
        "Nessun dato ricevuto dal provider"
      );
    }

    return data.values
      .reverse()
      .map(value => ({
        time: value.datetime,
        open: Number(value.open),
        high: Number(value.high),
        low: Number(value.low),
        close: Number(value.close)
      }))
      .filter(
        bar =>
          Number.isFinite(bar.open) &&
          Number.isFinite(bar.high) &&
          Number.isFinite(bar.low) &&
          Number.isFinite(bar.close)
      );
  } finally {
    clearTimeout(timeout);
  }
}

/*
  ============================================================
  ANALISI MULTI-TIMEFRAME
  ============================================================
*/

function combineTimeframes(timeframeResults) {
  const results = Object.values(timeframeResults || {});

  const valid = results.filter(
    result =>
      result &&
      result.status !== "ERROR"
  );

  const buys = valid.filter(
    result =>
      result.status === "SIGNAL" &&
      result.direction === "BUY"
  ).length;

  const sells = valid.filter(
    result =>
      result.status === "SIGNAL" &&
      result.direction === "SELL"
  ).length;

  /*
    Almeno 2 timeframe BUY
  */

  if (buys >= 2 && sells === 0) {
    return {
      status: "SIGNAL",
      direction: "BUY",
      confirmation: `${buys}/3 timeframe concordi`
    };
  }

  /*
    Almeno 2 timeframe SELL
  */

  if (sells >= 2 && buys === 0) {
    return {
      status: "SIGNAL",
      direction: "SELL",
      confirmation: `${sells}/3 timeframe concordi`
    };
  }

  /*
    BUY e SELL contemporaneamente
  */

  if (buys > 0 && sells > 0) {
    return {
      status: "CONFLICT",
      direction: null,
      confirmation: "Timeframe in conflitto"
    };
  }

  /*
    Nessuna conferma
  */

  return {
    status: "WAIT",
    direction: null,
    confirmation: "Nessuna conferma sufficiente"
  };
}

/*
  ============================================================
  SCANSIONE DI UN SINGOLO MERCATO
  ============================================================
*/

async function scanSymbol(symbol) {
  const timeframeResults = {};

  /*
    Eseguiamo i tre timeframe.
    Se uno fallisce, gli altri continuano.
  */

  for (const interval of INTERNAL_INTERVALS) {
    try {
      const bars = await getSeries(
        symbol,
        interval
      );

      timeframeResults[interval] =
        analyze(
          symbol,
          bars,
          interval
        );

    } catch (error) {
      timeframeResults[interval] = {
        symbol,
        interval,
        status: "ERROR",
        error: error.message
      };
    }
  }

  const combined =
    combineTimeframes(
      timeframeResults
    );

  /*
    Se almeno un timeframe contiene un prezzo,
    usiamo quello come prezzo corrente.
  */

  const priceSource =
    timeframeResults["5min"] ||
    timeframeResults["15min"] ||
    timeframeResults["1h"];

  return {
    symbol,

    status: combined.status,
    direction: combined.direction,
    confirmation: combined.confirmation,

    price:
      priceSource?.price ?? null,

    timeframes: timeframeResults
  };
}

/*
  ============================================================
  SCANSIONE COMPLETA
  ============================================================
*/

async function performScan() {
  /*
    Se non abbiamo API key non possiamo fare la scansione.
  */

  if (!API_KEY) {
    lastScan = {
      status: "waiting_for_api_key",
      updatedAt: new Date().toISOString(),
      scanning: false,
      signals: []
    };

    return lastScan;
  }

  /*
    Stato di scansione
  */

  lastScan = {
    ...lastScan,
    status: "scanning",
    scanning: true
  };

  const results = [];

  /*
    I mercati vengono analizzati uno per uno per evitare
    di mandare troppe richieste contemporaneamente
    al provider.
  */

  for (const symbol of SYMBOLS) {
    try {
      const result =
        await scanSymbol(symbol);

      results.push(result);

    } catch (error) {
      results.push({
        symbol,
        status: "ERROR",
        direction: null,
        confirmation: "Errore durante la scansione",
        price: null,
        error: error.message,
        timeframes: {}
      });
    }
  }

  lastScan = {
    status: "online",
    updatedAt: new Date().toISOString(),
    scanning: false,

    /*
      Configurazione utile al sistema.
      I timeframe NON vengono esposti qui.
    */

    config: {
      bars: CONFIG.bars,
      minTests: CONFIG.minTests,
      rr: CONFIG.rr,
      riskPct: CONFIG.riskPct,
      zoneAtrMult: CONFIG.zoneAtrMult
    },

    markets: SYMBOLS,

    signals: results
  };

  return lastScan;
}

/*
  ============================================================
  SCAN CONTROLLATA DA CACHE
  ============================================================
*/

async function scanAll() {
  /*
    Se una scansione è già in corso,
    aspettiamo quella invece di crearne un'altra.
  */

  if (scanPromise) {
    return scanPromise;
  }

  /*
    Se abbiamo una scansione recente,
    restituiamo immediatamente i dati già disponibili.
  */

  if (
    lastScan.status === "online" &&
    lastScan.updatedAt &&
    Date.now() -
      new Date(lastScan.updatedAt).getTime() <
      CACHE_MS
  ) {
    return lastScan;
  }

  /*
    Prima apertura o cache scaduta:
    scansione IMMEDIATA.
  */

  scanPromise = performScan();

  try {
    return await scanPromise;
  } finally {
    scanPromise = null;
  }
}

/*
  ============================================================
  HEALTH
  ============================================================
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "market-sentinel-engine",
      status: lastScan.status,
      updatedAt: lastScan.updatedAt
    });
  }
);

/*
  ============================================================
  SIGNALS
  ============================================================
*/

app.get(
  "/api/signals",
  async (req, res) => {
    try {
      const result =
        await scanAll();

      res.json(result);

    } catch (error) {
      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

/*
  ============================================================
  FORCE REFRESH
  ============================================================
  
  Questo endpoint serve se vogliamo forzare una nuova
  scansione senza aspettare i 5 minuti della cache.
*/

app.get(
  "/api/refresh",
  async (req, res) => {
    try {
      /*
        Se non c'è già una scansione in corso,
        invalidiamo la cache.
      */

      if (!scanPromise) {
        lastScan.updatedAt = null;
      }

      const result =
        await scanAll();

      res.json(result);

    } catch (error) {
      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

/*
  ============================================================
  ROOT
  ============================================================
*/

app.get(
  "/",
  (req, res) => {
    res.json({
      service: "Market Sentinel Engine",
      status: lastScan.status,
      message: "Server online"
    });
  }
);

/*
  ============================================================
  AVVIO
  ============================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Market Sentinel Engine listening on ${PORT}`
    );
  }
);
