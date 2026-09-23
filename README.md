
# Market Sentinel Engine

Motore backend per Market Sentinel. Scansiona mercati forex, individua swing high/low,
raggruppa i livelli vicini in zone, conta i test e cerca una reazione vicino alla zona.

## Sicurezza
- NON apre ordini.
- NON contiene credenziali broker.
- Genera solo segnali tecnici.
- Prima di usarlo con denaro reale va testato/backtestato.

## Dati reali
Il motore usa Twelve Data tramite la variabile d'ambiente `TWELVE_DATA_API_KEY`.
La documentazione ufficiale supporta `/time_series`, simboli forex come `EUR/USD` e intervalli
come `5min`, `15min` e `1h`.

## Deploy su Render
1. Carica questi file in un repository GitHub separato, per esempio `market-sentinel-engine`.
2. In Render crea `New -> Web Service` e collega il repository.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Aggiungi Environment Variable:
   `TWELVE_DATA_API_KEY = la_tua_chiave`
6. Lascia `PORT` gestita da Render.
7. Endpoint:
   `/health`
   `/api/signals`

## Variabili opzionali
- `SYMBOLS=EUR/USD,GBP/USD,USD/JPY,...`
- `INTERVAL=15min`
- `BARS=250`
- `MIN_TESTS=2`
- `RR=2`
- `RISK_PCT=2`
- `ZONE_ATR_MULT=0.35`

Il frontend GitHub Pages potrà poi leggere `/api/signals` dall'URL pubblico del servizio.
