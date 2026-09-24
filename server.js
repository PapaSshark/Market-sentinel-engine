const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";

// ======================================================
// MERCATI
// ======================================================

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

// Timeframe utilizzati internamente.
// NON vengono esposti come impostazioni utente.
const INTERVALS = [
  "5min",
  "15min",
  "1h"
];

// ======================================================
// CONFIGURAZIONE
// ======================================================

const CONFIG = {
  bars: 250,

  // Numero minimo di test per creare una zona
  minTests: 2,

  // Rapporto rischio/rendimento
  rr: 2,

  // Rischio indicativo
  riskPct: 2,

  // Ampiezza zona rispetto all'ATR
  zoneAtrMult: 0.35,

  // Distanza massima dalla zona per considerarla vicina
  approachAtrMult: 1.5,

  // Swing
  swingLeft: 3,
  swingRight: 3
};

// Cache analisi: 5 minuti
const CACHE_MS = 5 * 60 * 1000;

// Cache prezzi live: 30 secondi
const PRICE_CACHE_MS = 30 * 1000;

// ======================================================
// STATO
// ======================================================

let lastScan = {
  status: "waiting_for_scan",
  updatedAt: null,
  signals: []
};

let scanning = false;

// Cache prezzi live
const priceCache = new Map();

// ======================================================
// UTILITY
// ======================================================

function roundPrice(value, symbol) {
  if (!Number.isFinite(value)) {
    return null;
  }

  // Oro
  if (symbol === "XAU/USD") {
    return Number(value.toFixed(2));
  }

  // Coppie con prezzo basso
  if (Math.abs(value) < 10) {
    return Number(value.toFixed(5));
  }

  // JPY e prezzi più alti
  return Number(value.toFixed(3));
}

// ======================================================
// ATR
// ======================================================

function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const previous = bars[i - 1];

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(trueRange);
  }

  const values = trs.slice(-period);

  if (!values.length) {
    return null;
  }

  return (
    values.reduce((sum, value) => sum + value, 0) /
    values.length
  );
}

// ======================================================
// SWING HIGH / SWING LOW
// ======================================================

function swings(bars) {
  const result = [];

  for (
    let i = CONFIG.swingLeft;
    i < bars.length - CONFIG.swingRight;
    i++
  ) {
    const candle = bars[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= CONFIG.swingLeft; j++) {
      if (bars[i - j].high >= candle.high) {
        isHigh = false;
      }

      if (bars[i - j].low <= candle.low) {
        isLow = false;
      }
    }

    for (let j = 1; j <= CONFIG.swingRight; j++) {
      if (bars[i + j].high >= candle.high) {
        isHigh = false;
      }

      if (bars[i + j].low <= candle.low) {
        isLow = false;
      }
    }

    if (isHigh) {
      result.push({
        type: "resistance",
        price: candle.high,
        index: i
      });
    }

    if (isLow) {
      result.push({
        type: "support",
        price: candle.low,
        index: i
      });
    }
  }

  return result;
}

// ======================================================
// CREAZIONE ZONE
// ======================================================

function makeZones(bars) {
  const averageTrueRange = atr(bars);

  if (!averageTrueRange) {
    return [];
  }

  const tolerance =
    averageTrueRange * CONFIG.zoneAtrMult;

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
        indices: []
      };

      zones.push(zone);
    }

    zone.prices.push(point.price);
    zone.indices.push(point.index);

    zone.center =
      zone.prices.reduce(
        (sum, value) => sum + value,
        0
      ) / zone.prices.length;
  }

  for (const zone of zones) {
    zone.tests = zone.prices.length;

    zone.low =
      zone.center - tolerance / 2;

    zone.high =
      zone.center + tolerance / 2;

    zone.lastTest =
      Math.max(...zone.indices);

    zone.score = Math.min(
      100,
      40 +
        zone.tests * 12 +
        Math.min(
          30,
          (zone.lastTest / bars.length) * 30
        )
    );
  }

  return zones.filter(
    zone => zone.tests >= CONFIG.minTests
  );
}

// ======================================================
// ZONA PIÙ VICINA
// ======================================================

function getNearestZone(zones, price) {
  if (!zones || !zones.length) {
    return null;
  }

  return zones
    .map(zone => ({
      ...zone,
      distance: Math.abs(
        price - zone.center
      )
    }))
    .sort(
      (a, b) => a.distance - b.distance
    )[0];
}

// ======================================================
// FORMAT ZONA
// ======================================================

function formatZone(zone, symbol) {
  if (!zone) {
    return null;
  }

  return {
    type: zone.type,

    center: roundPrice(
      zone.center,
      symbol
    ),

    low: roundPrice(
      zone.low,
      symbol
    ),

    high: roundPrice(
      zone.high,
      symbol
    ),

    tests: zone.tests,

    score: Math.round(zone.score),

    distance: roundPrice(
      zone.distance,
      symbol
    )
  };
}

// ======================================================
// ANALISI TECNICA
// ======================================================

function analyze(
  symbol,
  bars,
  interval,
  livePrice = null
) {
  if (!bars || bars.length < 30) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price: null,
      reason: "Dati insufficienti"
    };
  }

  const candlePrice =
    bars[bars.length - 1].close;

  // Se abbiamo il prezzo live usiamo quello.
  // Altrimenti usiamo la chiusura della candela.
  const price =
    Number.isFinite(livePrice)
      ? livePrice
      : candlePrice;

  const averageTrueRange = atr(bars);

  if (!averageTrueRange) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price,
      reason: "ATR non disponibile"
    };
  }

  const zones = makeZones(bars);

  if (!zones.length) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price,
      nearestZone: null,
      reason:
        "Nessuna zona con almeno 2 test"
    };
  }

  const nearest =
    getNearestZone(
      zones,
      price
    );

  if (!nearest) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price,
      reason:
        "Nessuna zona disponibile"
    };
  }

  const approachDistance =
    averageTrueRange *
    CONFIG.approachAtrMult;

  if (
    nearest.distance >
    approachDistance
  ) {
    return {
      symbol,
      interval,
      status: "WAIT",
      price,

      nearestZone:
        formatZone(
          nearest,
          symbol
        ),

      reason:
        "Prezzo ancora lontano dalla zona"
    };
  }

  const last =
    bars[bars.length - 1];

  const previous =
    bars[bars.length - 2];

  const bullishCandle =
    last.close > last.open;

  const bearishCandle =
    last.close < last.open;

  let direction = null;
  let reaction = false;

  // ====================================================
  // SUPPORTO
  // ====================================================

  if (nearest.type === "support") {
    const rejection =
      last.low <= nearest.high &&
      bullishCandle;

    const bullishBreak =
      last.close > previous.high;

    if (
      rejection ||
      bullishBreak
    ) {
      direction = "BUY";
      reaction = true;
    }
  }

  // ====================================================
  // RESISTENZA
  // ====================================================

  if (
    nearest.type ===
    "resistance"
  ) {
    const rejection =
      last.high >= nearest.low &&
      bearishCandle;

    const bearishBreak =
      last.close < previous.low;

    if (
      rejection ||
      bearishBreak
    ) {
      direction = "SELL";
      reaction = true;
    }
  }

  // ====================================================
  // NESSUNA CONFERMA
  // ====================================================

  if (
    !direction ||
    !reaction
  ) {
    return {
      symbol,
      interval,
      status: "APPROACH",
      price,

      nearestZone:
        formatZone(
          nearest,
          symbol
        ),

      reason:
        nearest.type ===
        "support"
          ? "Vicino al supporto, manca conferma BUY"
          : "Vicino alla resistenza, manca conferma SELL"
    };
  }

  // ====================================================
  // SL / TP
  // ====================================================

  const entry = price;

  let sl;
  let tp;

  if (direction === "BUY") {
    sl =
      nearest.low -
      averageTrueRange * 0.15;

    tp =
      entry +
      (entry - sl) *
        CONFIG.rr;
  }

  if (direction === "SELL") {
    sl =
      nearest.high +
      averageTrueRange * 0.15;

    tp =
      entry -
      (sl - entry) *
        CONFIG.rr;
  }

  return {
    symbol,
    interval,

    status: "SIGNAL",

    direction,

    price:
      roundPrice(
        price,
        symbol
      ),

    zone: {
      type: nearest.type,

      low:
        roundPrice(
          nearest.low,
          symbol
        ),

      high:
        roundPrice(
          nearest.high,
          symbol
        ),

      tests:
        nearest.tests,

      score:
        Math.round(
          nearest.score
        )
    },

    entry:
      roundPrice(
        entry,
        symbol
      ),

    sl:
      roundPrice(
        sl,
        symbol
      ),

    tp:
      roundPrice(
        tp,
        symbol
      ),

    rr: CONFIG.rr,

    riskPct:
      CONFIG.riskPct,

    reason:
      nearest.type ===
      "support"
        ? "Supporto + reazione rialzista"
        : "Resistenza + reazione ribassista",

    note:
      "Segnale tecnico. Nessun ordine automatico."
  };
}

// ======================================================
// TIME SERIES TWELVE DATA
// ======================================================

async function getSeries(
  symbol,
  interval
) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY non configurata"
    );
  }

  const url =
    new URL(
      "https://api.twelvedata.com/time_series"
    );

  url.searchParams.set(
    "symbol",
    symbol
  );

  url.searchParams.set(
    "interval",
    interval
  );

  url.searchParams.set(
    "outputsize",
    String(CONFIG.bars)
  );

  url.searchParams.set(
    "timezone",
    "UTC"
  );

  url.searchParams.set(
    "apikey",
    API_KEY
  );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      15000
    );

  let response;

  try {
    response =
      await fetch(
        url,
        {
          signal:
            controller.signal
        }
      );
  } catch (error) {
    if (
      error.name ===
      "AbortError"
    ) {
      throw new Error(
        "Timeout Twelve Data"
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `Provider HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    data.status ===
    "error"
  ) {
    throw new Error(
      data.message ||
        "Errore Twelve Data"
    );
  }

  if (
    !Array.isArray(
      data.values
    )
  ) {
    throw new Error(
      "Nessun dato ricevuto da Twelve Data"
    );
  }

  const bars =
    data.values
      .reverse()
      .map(value => ({
        time:
          value.datetime,

        open:
          Number(value.open),

        high:
          Number(value.high),

        low:
          Number(value.low),

        close:
          Number(value.close)
      }))
      .filter(
        bar =>
          Number.isFinite(
            bar.open
          ) &&
          Number.isFinite(
            bar.high
          ) &&
          Number.isFinite(
            bar.low
          ) &&
          Number.isFinite(
            bar.close
          )
      );

  if (
    bars.length < 30
  ) {
    throw new Error(
      "Dati insufficienti ricevuti da Twelve Data"
    );
  }

  return bars;
}

// ======================================================
// PREZZO LIVE TWELVE DATA
// ======================================================

async function getLivePrice(
  symbol
) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY non configurata"
    );
  }

  // Controllo cache
  const cached =
    priceCache.get(symbol);

  if (
    cached &&
    Date.now() -
      cached.timestamp <
      PRICE_CACHE_MS
  ) {
    return {
      price: cached.price,
      source:
        "Twelve Data /price",
      updatedAt:
        cached.updatedAt
    };
  }

  const url =
    new URL(
      "https://api.twelvedata.com/price"
    );

  url.searchParams.set(
    "symbol",
    symbol
  );

  url.searchParams.set(
    "apikey",
    API_KEY
  );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
    );

  let response;

  try {
    response =
      await fetch(
        url,
        {
          signal:
            controller.signal
        }
      );
  } catch (error) {
    if (
      error.name ===
      "AbortError"
    ) {
      throw new Error(
        "Timeout prezzo live Twelve Data"
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `Price provider HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    data.status ===
    "error"
  ) {
    throw new Error(
      data.message ||
        "Errore Twelve Data price"
    );
  }

  const price =
    Number(data.price);

  if (
    !Number.isFinite(price)
  ) {
    throw new Error(
      "Prezzo non valido da Twelve Data"
    );
  }

  const updatedAt =
    new Date().toISOString();

  priceCache.set(
    symbol,
    {
      price,
      timestamp:
        Date.now(),
      updatedAt
    }
  );

  return {
    price,
    source:
      "Twelve Data /price",
    updatedAt
  };
}

// ======================================================
// CONFERMA MULTI-TIMEFRAME
// ======================================================

function combineTimeframes(
  results
) {
  const values =
    Object.values(
      results
    );

  const signals =
    values.filter(
      result =>
        result &&
        result.status ===
          "SIGNAL"
    );

  const buys =
    signals.filter(
      result =>
        result.direction ===
        "BUY"
    ).length;

  const sells =
    signals.filter(
      result =>
        result.direction ===
        "SELL"
    ).length;

  // 2 timeframe BUY
  if (
    buys >= 2 &&
    sells === 0
  ) {
    return {
      status: "SIGNAL",
      direction: "BUY",
      confirmation:
        `${buys}/3 timeframe concordi`
    };
  }

  // 2 timeframe SELL
  if (
    sells >= 2 &&
    buys === 0
  ) {
    return {
      status: "SIGNAL",
      direction: "SELL",
      confirmation:
        `${sells}/3 timeframe concordi`
    };
  }

  // Conflitto
  if (
    buys > 0 &&
    sells > 0
  ) {
    return {
      status: "CONFLICT",
      direction: null,
      confirmation:
        "Timeframe in conflitto"
    };
  }

  const approaches =
    values.filter(
      result =>
        result &&
        result.status ===
          "APPROACH"
    ).length;

  if (
    approaches > 0
  ) {
    return {
      status: "APPROACH",
      direction: null,
      confirmation:
        `${approaches}/3 timeframe vicini a una zona`
    };
  }

  return {
    status: "WAIT",
    direction: null,
    confirmation:
      "Nessuna conferma sufficiente"
  };
}

// ======================================================
// ANALIZZA UN MERCATO
// ======================================================

async function scanSymbol(
  symbol
) {
  const timeframeResults =
    {};

  // ----------------------------------------------
  // PREZZO LIVE
  // ----------------------------------------------

  let livePrice = null;
  let livePriceSource =
    null;
  let livePriceUpdatedAt =
    null;
  let livePriceError =
    null;

  try {
    const live =
      await getLivePrice(
        symbol
      );

    livePrice =
      live.price;

    livePriceSource =
      live.source;

    livePriceUpdatedAt =
      live.updatedAt;
  } catch (error) {
    livePriceError =
      error.message;
  }

  // ----------------------------------------------
  // TIMEFRAME
  // ----------------------------------------------

  for (
    const interval of
    INTERVALS
  ) {
    try {
      const bars =
        await getSeries(
          symbol,
          interval
        );

      timeframeResults[
        interval
      ] =
        analyze(
          symbol,
          bars,
          interval,
          livePrice
        );
    } catch (error) {
      timeframeResults[
        interval
      ] = {
        symbol,
        interval,
        status: "ERROR",
        error:
          error.message
      };
    }
  }

  // ----------------------------------------------
  // CONFERMA
  // ----------------------------------------------

  const combined =
    combineTimeframes(
      timeframeResults
    );

  // ----------------------------------------------
  // FALLBACK
  // ----------------------------------------------

  const priceResult =
    timeframeResults["5min"] ||
    timeframeResults["15min"] ||
    timeframeResults["1h"];

  const fallbackPrice =
    priceResult &&
    Number.isFinite(
      priceResult.price
    )
      ? priceResult.price
      : null;

  const finalPrice =
    livePrice !== null
      ? livePrice
      : fallbackPrice;

  // ----------------------------------------------
  // DIAGNOSTICA
  // ----------------------------------------------

  const signalCount =
    Object.values(
      timeframeResults
    ).filter(
      result =>
        result &&
        result.status ===
          "SIGNAL"
    ).length;

  const approachCount =
    Object.values(
      timeframeResults
    ).filter(
      result =>
        result &&
        result.status ===
          "APPROACH"
    ).length;

  const errorCount =
    Object.values(
      timeframeResults
    ).filter(
      result =>
        result &&
        result.status ===
          "ERROR"
    ).length;

  return {
    symbol,

    // Stato generale
    status:
      combined.status,

    direction:
      combined.direction,

    confirmation:
      combined.confirmation,

    // ==========================================
    // PREZZO ATTUALE
    // ==========================================

    price:
      finalPrice !== null
        ? roundPrice(
            finalPrice,
            symbol
          )
        : null,

    livePrice:
      livePrice !== null
        ? roundPrice(
            livePrice,
            symbol
          )
        : null,

    priceSource:
      livePrice !== null
        ? livePriceSource
        : "5min fallback",

    priceUpdatedAt:
      livePrice !== null
        ? livePriceUpdatedAt
        : null,

    priceError:
      livePriceError,

    // ==========================================
    // DIAGNOSTICA
    // ==========================================

    diagnostics: {
      signalTimeframes:
        signalCount,

      approachTimeframes:
        approachCount,

      errorTimeframes:
        errorCount
    },

    // ==========================================
    // DATI TIMEFRAME
    // ==========================================

    timeframes:
      timeframeResults
  };
}

// ======================================================
// SCANSIONE COMPLETA
// ======================================================

async function scanAll(
  force = false
) {
  if (!API_KEY) {
    return {
      status:
        "waiting_for_api_key",

      updatedAt:
        new Date().toISOString(),

      markets:
        SYMBOLS,

      signals: []
    };
  }

  // ----------------------------------------------
  // CACHE ANALISI
  // ----------------------------------------------

  if (
    !force &&
    lastScan.status ===
      "online" &&
    lastScan.updatedAt &&
    Date.now() -
      new Date(
        lastScan.updatedAt
      ).getTime() <
      CACHE_MS
  ) {
    return lastScan;
  }

  // ----------------------------------------------
  // EVITA DUE SCANSIONI CONTEMPORANEE
  // ----------------------------------------------

  if (scanning) {
    return lastScan;
  }

  scanning = true;

  try {
    const results =
      [];

    // ------------------------------------------
    // SCANSIONE MERCATI
    // ------------------------------------------

    for (
      const symbol of
      SYMBOLS
    ) {
      try {
        const result =
          await scanSymbol(
            symbol
          );

        results.push(
          result
        );
      } catch (error) {
        results.push({
          symbol,

          status: "ERROR",

          direction: null,

          confirmation:
            "Errore durante l'analisi",

          price: null,

          livePrice: null,

          priceSource: null,

          priceUpdatedAt:
            null,

          priceError:
            error.message,

          diagnostics: {
            signalTimeframes: 0,
            approachTimeframes: 0,
            errorTimeframes: 3
          },

          timeframes: {},

          error:
            error.message
        });
      }
    }

    // ------------------------------------------
    // SALVA RISULTATO
    // ------------------------------------------

    lastScan = {
      status: "online",

      updatedAt:
        new Date().toISOString(),

      config: {
        bars:
          CONFIG.bars,

        minTests:
          CONFIG.minTests,

        rr:
          CONFIG.rr,

        riskPct:
          CONFIG.riskPct,

        zoneAtrMult:
          CONFIG.zoneAtrMult,

        approachAtrMult:
          CONFIG.approachAtrMult
      },

      markets:
        SYMBOLS,

      signals:
        results
    };

    return lastScan;
  } finally {
    scanning = false;
  }
}

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "market-sentinel-engine",

      status:
        lastScan.status,

      updatedAt:
        lastScan.updatedAt,

      markets:
        SYMBOLS.length
    });
  }
);

// ======================================================
// API SIGNALS
// ======================================================

app.get(
  "/api/signals",
  async (req, res) => {
    try {
      const result =
        await scanAll(false);

      res.json(
        result
      );
    } catch (error) {
      console.error(
        "API SIGNALS ERROR:",
        error
      );

      res.status(500).json({
        status: "error",
        message:
          error.message
      });
    }
  }
);

// ======================================================
// FORCE REFRESH
// ======================================================

app.get(
  "/api/refresh",
  async (req, res) => {
    try {
      const result =
        await scanAll(true);

      res.json(
        result
      );
    } catch (error) {
      console.error(
        "REFRESH ERROR:",
        error
      );

      res.status(500).json({
        status: "error",
        message:
          error.message
      });
    }
  }
);

// ======================================================
// ROOT
// ======================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      service:
        "Market Sentinel Engine",

      status:
        lastScan.status,

      message:
        "Server online",

      markets:
        SYMBOLS
    });
  }
);

// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "SERVER ERROR:",
      error
    );

    res.status(500).json({
      status: "error",

      message:
        error.message ||
        "Errore interno del server"
    });
  }
);

// ======================================================
// AVVIO SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "MARKET SENTINEL ENGINE ONLINE"
    );

    console.log(
      `Porta: ${PORT}`
    );

    console.log(
      `Mercati: ${SYMBOLS.join(", ")}`
    );

    console.log(
      `Timeframe interni: ${INTERVALS.join(", ")}`
    );

    console.log(
      `Test minimi zona: ${CONFIG.minTests}`
    );

    console.log(
      `Distanza zona: ${CONFIG.approachAtrMult} ATR`
    );

    console.log(
      "Prezzi live: Twelve Data /price"
    );

    console.log(
      "Nessun ordine automatico"
    );

    console.log(
      "========================================"
    );
  }
);
