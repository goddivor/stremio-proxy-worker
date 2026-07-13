# Stremio Video Proxy — Cloudflare Worker

Proxy vidéo (HLS + MP4) pour les addons Stremio **voiranime** et **French Stream**, hébergé sur **Cloudflare Workers**.

## Pourquoi

Les hébergeurs vidéo (Vidmoly, Vidzy, Uqload…) verrouillent leurs liens à l'IP qui les extrait. Il faut donc proxifier le flux. Sur Vercel, ce trafic est facturé (« Fast Origin Transfer », 10 Go gratuits). **Cloudflare ne facture pas la bande passante sortante** → ce Worker déplace le flux vidéo sur Cloudflare, gratuitement.

## Ce que fait le Worker

| Route | Rôle |
|---|---|
| `/hls/{token}.m3u8` | Récupère une playlist HLS, réécrit toutes ses URLs vers le Worker, la renvoie |
| `/hls/{token}.ts` | Streame un segment vidéo |
| `/mp4/{token}.mp4` | Streame un MP4 avec relais des requêtes `Range` |

Le `token` est un `base64url` de `{u: url, r: referer}`, généré par les addons (identique des deux côtés grâce à `nodejs_compat`).

## Déploiement

### 1. Se connecter à Cloudflare

```bash
cd stremio-proxy-worker
npx wrangler login
```

(ouvre le navigateur, connecte-toi au compte Cloudflare qui gère `anadeb.tg`.)

### 2. Déployer

```bash
npx wrangler deploy
```

Le Worker est alors en ligne sur :
```
https://stremio-proxy.<ton-sous-compte>.workers.dev
```
Note cette URL — c'est elle qu'on donnera aux addons.

### 3. (Optionnel) Domaine personnalisé `proxy.anadeb.tg`

Dans `wrangler.toml`, décommenter :
```toml
routes = [ { pattern = "proxy.anadeb.tg", custom_domain = true } ]
```
Puis `npx wrangler deploy`. Cloudflare crée automatiquement le DNS + HTTPS (le domaine est déjà chez Cloudflare). Ça ne touche ni `anadeb.tg`, ni `dev.`, ni `sig.`.

## Brancher les addons sur le Worker

Dans chaque projet d'addon (branche `feat/cloudflare-worker-proxy`), il suffit de définir une variable d'environnement **sur Vercel** :

```
PROXY_BASE_URL = https://stremio-proxy.<...>.workers.dev
```
(ou `https://proxy.anadeb.tg` si domaine perso)

```bash
# exemple
printf "https://stremio-proxy.xxx.workers.dev" | vercel env add PROXY_BASE_URL production --force
vercel --prod --yes
```

Dès que `PROXY_BASE_URL` est définie, les liens vidéo générés par l'addon pointent vers le Worker au lieu de Vercel. Si elle est absente, l'addon retombe automatiquement sur le proxy Vercel (aucune régression).

## Test rapide

```bash
curl -s https://stremio-proxy.<...>.workers.dev/
# -> "Stremio video proxy — OK"
```
