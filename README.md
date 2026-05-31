# 🎙️ TONSPUR — Transkription im Browser

Statische Website zum Transkribieren von Videos & Audio. **Kein Backend, kein Server,
gratis hostbar** (z.B. GitHub Pages). Auch für lange Videos (2 Std+) und große Dateien (~500 MB).

## Wie's funktioniert

1. Du wählst ein Video/Audio (auch 300 MB+) — **die Datei wird NICHT hochgeladen**.
2. Der Browser extrahiert lokal mit **ffmpeg.wasm** nur die Tonspur und komprimiert sie
   (mono, 16 kHz, ~24 kbps → meist <20 MB, selbst bei 2 Std).
3. Nur diese kleine Tonspur geht an **Groq** (`whisper-large-v3`) → Transkript zurück.
4. Ergebnis als **Fließtext, SRT, VTT, JSON** zum Download.

Dein Groq-Key liegt **nur in deinem Browser** (localStorage) — nie im Code, nie auf GitHub.

## Groq-Key (einmalig)

1. Gratis-Key auf [console.groq.com/keys](https://console.groq.com/keys).
2. In der App oben rechts auf **🔑** → einfügen → speichern.

Kosten: ~11 ct/Std (large-v3) bzw. ~4 ct/Std (turbo), mit großzügigem Free-Tier.

## Lokal testen

```bash
cd transcriber-web
python3 -m http.server 8778
# → http://localhost:8778
```

## Auf GitHub Pages veröffentlichen

```bash
cd transcriber-web
git init && git add -A && git commit -m "TONSPUR"
git branch -M main
git remote add origin https://github.com/<dein-user>/<repo>.git
git push -u origin main
```

Dann auf GitHub: **Settings → Pages → Branch `main` / Ordner `/root` → Save**.
Nach ein paar Minuten ist die App live unter `https://<dein-user>.github.io/<repo>/`.

> Wichtig: Der gesamte Inhalt dieses Ordners (inkl. `vendor/`, ~32 MB ffmpeg-Core) muss mit
> hochgeladen werden. Die `.nojekyll`-Datei sorgt dafür, dass GitHub alle Dateien ausliefert.

## Aufbau

- **`index.html`** — Landing-Page (Hero, Features, So funktioniert's) im Obsidian-Look
- **`app.html`** — das eigentliche Transkriptions-Studio (Dashboard). Von der Landing aus
  über „App öffnen" / „Jetzt transkribieren" erreichbar.

## Dateien

- `index.html` + `landing.css` + `landing.js` — Landing-Page (Scroll-Reveals, Nav-Blur)
- `app.html` + `styles.css` + `app.js` — das Studio (ffmpeg.wasm-Extraktion + Chunking +
  Groq-Transkription + KI-Veredelung)
- `bg.js` — animierter Hintergrund (fließende violette „Adern"), von beiden Seiten genutzt
- `vendor/` — mitgeliefertes ffmpeg.wasm (lokal eingebunden, damit der Worker ohne
  Cross-Origin-Probleme lädt — funktioniert so auf GitHub Pages)

Design: Obsidian-Dunkel + Lila, Bricolage Grotesque + IBM Plex Mono.

## Grenzen

- Sehr große Dateien (>~500 MB) können den Browser-Speicher sprengen (ffmpeg.wasm lädt die
  Datei in den RAM). Für solche Fälle ist die lokale Python-App (`../transcriber-app/`) besser.
- **Links (YouTube etc.)** gehen hier nicht — eine reine Browser-Seite kann kein yt-dlp
  ausführen. Datei direkt hochladen, oder die lokale App nutzen.
