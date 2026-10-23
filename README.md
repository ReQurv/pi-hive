# @requrv/pi-hive

Provider **ReQurv Hive** per [pi](https://github.com/earendil-works/pi) e [omp](https://github.com/oh-my-pi/pi): registra il provider `requrv-hive`, lo rende disponibile in `/login` come "ReQurv Hive", legge i modelli live da `GET https://hive.requrv.ai/api/v1/models` e aggiunge il tool `hive_generate_image`.

## Installazione

Da npm:

```bash
pi install npm:@requrv/pi-hive
omp plugin install @requrv/pi-hive
```

Direttamente da git (nessuna pubblicazione richiesta):

```bash
pi install git:github.com/requrv/pi-hive           # clone in ~/.pi/agent/git/
pi install git:github.com/requrv/pi-hive@v0.1.0    # ref pinnata
omp plugin install github:requrv/pi-hive           # via bun install nel plugins dir
omp plugin install https://github.com/requrv/pi-hive
```

Da locale (sviluppo):

```bash
pi install ~/dev/pi-hive              # persistente (settings)
pi -e ~/dev/pi-hive/index.ts          # solo questa sessione
omp plugin link ~/dev/pi-hive         # link persistente
```

Nessuna dipendenza runtime: `typebox` è dev-only e i due host iniettano già il proprio `Type` (pi via alias jiti, omp via shim). Il pacchetto funziona anche copiato senza `node_modules`.

## Uso

Su **pi** il provider compare in `/login` con due metodi:

| voce | cosa fa |
| --- | --- |
| *Sign in with an account* | prompt "Chiave API ReQurv Hive" (testo visibile) |
| *Sign in with an API key* | prompt "Enter API key" (input mascherato, `type:"secret"`) |

Entrambi validano subito la chiave contro `/models`. Su **omp** esiste solo il primo (`/login` di omp è costruito dai soli provider OAuth).

In alternativa, senza `/login`:

```bash
export HIVE_API_KEY=requrv_sk_...   # usata da pi (apiKey "$HIVE_API_KEY")
```

Poi una volta sola:

```
/model  →  ReQurv Hive → requrv-small-3.8
```

`pi` non ha un modello predefinito per i provider di terze parti: dopo il login mostra `Logged in to ReQurv Hive, but no default model is configured for provider "requrv-hive"`. È il messaggio generico di pi per ogni provider registrato da un'estensione (`defaultModelPerProvider` è una mappa statica dei soli provider built-in), non un errore del plugin. Scegliendo il modello con `/model` sparisce. Per evitare anche quel primo giro:

```json
// ~/.pi/agent/settings.json
{ "defaultModel": "requrv-hive/requrv-small-3.8" }
```

La credenziale OAuth resta con `expires = now + 10 anni` e non viene mai refreshata: è una chiave statica, non un token.

## Modelli

La lista arriva dal gateway, non dal pacchetto:

| campo `/models` | uso |
| --- | --- |
| `context_window`, `max_output_tokens` | `contextWindow`, `maxTokens` |
| `input_cost`, `output_cost` | `cost` (USD per milione di token) |
| `reasoning_efforts` | livelli di thinking effettivamente accettati |
| `type: TEXT_GENERATION` | unico tipo registrato come modello chat |

Su **pi** la discovery passa da `refreshModels`: nessuna rete allo startup, la TUI aggiorna la lista. In print mode (`pi -p`) o a rete spenta si usa un **seed** con `requrv-small-3.8` (262 144 / 32 768, effort `low`/`medium`/`xhigh`).

Su **omp** la discovery passa da `fetchDynamicModels` con cache SQLite (24 h): `models` non viene registrato, altrimenti omp userebbe il ramo statico e non chiamerebbe mai `/models`.

I modelli con `reasoning_efforts` ricevono entrambe le forme di effort (pi: `thinkingLevelMap`, omp: `thinking`) — ogni host ignora l'altra.

## Immagini

Tool `hive_generate_image` → `POST /images/generations` con `model: requrv-image`, salva `hive-image-<timestamp>.png` nella cwd. Il base64 non entra nel contesto: al modello torna solo il percorso del file.

`size` è un suggerimento: il gateway ha restituito 2048×2048 anche con il default 1024×1024 (verificato su pi e omp).

## Base URL

```bash
export HIVE_OPENAI_BASE_URL=https://hive.requrv.ai/api/v1
```

Default: `https://hive.requrv.ai/api/v1`. Deve includere `/api/v1` (il provider aggiunge solo `/chat/completions`, `/models`, `/images/generations`).

## Verifica

```bash
bun check.ts   # mapping di /models + payload degeneri
```

## Licenza

GPL-3.0-or-later.
