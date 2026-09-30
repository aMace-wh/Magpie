# Magpie 🐦‍⬛✨

**Save it. Sort it. Actually do it.**

Magpie is an installable, offline-first web app (PWA) for everything you save "for later": TikToks, Reels,
YouTube videos, recipes, restaurants, places, workouts, products, books and ideas. It sorts saves automatically,
puts places on a map and keeps a journal of what you actually did.

Inspired by save-for-later apps like Albo (formerly Sortd). All code here is original.

## Features

- **Save from anywhere.** Once installed, Magpie shows up in the Android / ChromeOS / Windows share sheet
  (Web Share Target). You can also paste links or type notes with the **+** button.
- **Smart sorting on your device.** Works out what each save is (recipe, place, video, workout, product,
  article, book, music, note), which platform it came from, a clean title and starter tags. For example, a
  TikTok pasta video is filed as a *recipe* and tagged `#pasta #quick`. No account and no AI service needed.
- **Link previews.** Fetches real titles and thumbnails in the background. You can turn this off in Settings.
- **Collections.** Hand-picked ones, plus **smart collections** that fill themselves based on tags, kinds of
  saves and status. A live preview shows what a smart collection will contain.
- **Map.** Every save with a location gets a pin. Filter by *Want to go* / *Visited* and by collection.
  Coordinates are read straight from Google / Apple / OSM map links, or you can search for a place.
- **Journal.** Mark things done ("I cooked this", "I've been here"), rate them and write a note. The journal
  shows your history, stats and the tags you rate highest.
- **Pick for me.** Can't decide? Magpie picks something you saved but haven't done yet.
- **Share collections with friends.** No server involved: the collection is compressed into the link itself.
- **Offline, private, yours.** Everything is stored in IndexedDB on your device. Backup and restore use JSON files.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build (service worker enabled)
npm run icons      # regenerate PNG icons from public/favicon.svg
```

Stack: React 19, TypeScript, Vite, vite-plugin-pwa (Workbox), Dexie (IndexedDB), Leaflet + OpenStreetMap,
lucide icons.

## Deploying

The build is static and uses relative paths and hash routing, so it runs from any sub-path. The included
GitHub Actions workflow tests, builds and publishes `main` to GitHub Pages. Enable it under
**Settings → Pages → Source: GitHub Actions**. Any static host with HTTPS works. HTTPS is required for
installation and the service worker.

## Third-party services

These are all optional. The app works fully offline without them.

| What | Service | When |
| --- | --- | --- |
| Link previews | [noembed.com](https://noembed.com), [microlink.io](https://microlink.io) | After saving a link (can be disabled) |
| Map tiles | OpenStreetMap | When viewing a map |
| Place search | OpenStreetMap Nominatim | When you search for a location |
