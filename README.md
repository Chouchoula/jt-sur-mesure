# JT Chatons Studio

Application de production d'épisodes TikTok / YouTube Shorts assistée par l'API Agnes.

## Démarrage rapide (mode sécurisé recommandé)

1. Copie `.env.example` en `.env` :
   ```powershell
   Copy-Item .env.example .env
   ```
2. Ouvre `.env` et renseigne ta clé :
   ```env
   AGNES_API_KEY=sk-...
   ```
3. Télécharge FFmpeg une seule fois pour le mode hors-ligne (facultatif mais recommandé) :
   ```powershell
   node prepare-vendor.mjs
   ```
4. Lance le serveur :
   ```powershell
   node server.mjs
   ```
   ou double-clique `start.cmd`.
5. Ouvre http://127.0.0.1:8787

Dans ce mode :
- la clé Agnes reste **côté serveur** et n'apparaît jamais dans le navigateur ;
- l'assemblage FFmpeg utilise les fichiers locaux `vendor/` s'ils existent, sinon un CDN ;
- la narration TTS est générée localement et **gravée dans le MP4 assemblé** (Windows SAPI, macOS `say`, Linux `espeak`).

## Mode direct (sans serveur)

Ouvre simplement `index.html` dans le navigateur. La génération fonctionne, mais :
- la clé API est stockée dans le navigateur et exposée aux scripts de la page ;
- la narration TTS n'est pas disponible pour l'export MP4 (seulement dans le lecteur intégré) ;
- FFmpeg et les modules associés sont chargés depuis un CDN.

Ce mode est adapté aux tests personnels, pas à un SaaS public.

## Diagnostic

Bouton **🔍 Tester l'API** dans le panneau des clés :
- interroge `GET /v1/models` ;
- si l'endpoint n'est pas disponible, fait un mini appel `chat/completions` ;
- affiche le mode, le nombre de clés, les modèles et la réponse brute dans la console intégrée.

## Rotation de clés

Le serveur accepte plusieurs clés :
```env
AGNES_API_KEYS=sk-cle-1,sk-cle-2,sk-cle-3
```
Elles sont utilisées en rotation à chaque requête. Le front-end réessaie automatiquement sur HTTP 429.

## Structure

| Fichier | Rôle |
| --- | --- |
| `index.html` | Application complète (HTML/CSS/JS) |
| `server.mjs` | Relais Agnes + TTS local + serveur statique |
| `prepare-vendor.mjs` | Télécharge FFmpeg.wasm dans `vendor/` |
| `.env.example` | Modèle de configuration |
| `start.cmd` | Lanceur Windows |
| `index.original.html` | Sauvegarde de la version d'origine |

## Notes

- Le serveur écoute sur `127.0.0.1` par défaut. Pour l'exposer sur un réseau, change `HOST`, mais ajoute alors une authentification et HTTPS.
- Les vidéos Agnes sont récupérées via leur URL directe ; en cas d'échec CORS, l'assemblage bascule sur `GET /v1/videos/{id}/content`.
- Le TTS local dépend des voix installées sur le système. Sous Windows, les voix françaises/anglaises standard de SAPI suffisent.
