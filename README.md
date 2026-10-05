# Magpie 🐦‍⬛✨

**Save it. Sort it. Actually do it.**

Magpie is an installable, offline-first web app (PWA) for everything you save "for later": TikToks, Reels,
YouTube videos, recipes, restaurants, places, workouts, products, books and ideas. It sorts saves automatically,
puts places on a map and keeps a journal of what you actually did.

Inspired by save-for-later apps like Albo (formerly Sortd). All code here is original.

## Features

- **Save from anywhere.** Once installed, Magpie shows up in the Android / ChromeOS / Windows share sheet
  (Web Share Target). You can also paste links or type notes with the **+** button.
- **Knows what you saved.** Works out what each save is (recipe, place, event, video, workout, product,
  article, book, music, note), which platform it came from, a clean title (no "Instagram · Log in" noise) and
  starter tags. For example, a TikTok pasta video is filed as a *recipe* and tagged `#pasta #quick`. The save
  sheet shows why it picked that kind and lets you switch with one tap. No account and no AI service needed.
  Instagram and other social posts are titled from their caption (in English, Chinese, Japanese or Korean), not
  the account's name, and saves from before that are tidied up once in the background, leaving what you set alone.
- **See the original.** Every save keeps exactly what was shared. Cards show a line of the original caption,
  and a save's page shows the original post, video or text, with a tap-to-load player for YouTube, TikTok,
  Instagram, X, Spotify and more, so you always recognise what you saved.
- **Events and dates.** Dates and periods in a post ("Sat 12 Oct, 7:30pm", "until 5 Jan") are picked up and
  can be edited. The library's **Coming up** strip lists what's on now and next, and any dated save, a whole
  collection or all of them can go to Google Calendar or any calendar app as an `.ics` file.
- **Places and countries.** Coordinates are read straight from Google / Apple / OSM map links, or you can
  search for a place. Every place gets its city, country and flag. The **Map** has a pin for each place, plus a
  **Countries** view that groups saves by country and city; collections can be viewed by country too, and
  the journal counts the countries you've been to. Search finds "Japan" or "Lisbon" too.
- **Link previews.** Fetches real titles and thumbnails in the background. You can turn this off in Settings.
- **Collections.** Hand-picked ones, plus **smart collections** that fill themselves based on tags, kinds of
  saves and status. A live preview shows what a smart collection will contain.
- **Journal.** Mark things done ("I cooked this", "I've been here"), rate them and write a note. The journal
  shows your history, stats, the countries you've visited and the tags you rate highest.
- **Pick for me.** Can't decide? Magpie picks something you saved but haven't done yet.
- **Share with friends.** Send one save, a collection or your whole library through WhatsApp, Telegram,
  Messenger, LINE, X, Reddit, email, SMS or your phone's share sheet. No server is involved: the saves are
  compressed into the link itself, and when that gets too long Magpie sends a small `.magpie.json` file
  instead. Your notes and ratings (and, in a whole-library share, your text notes) stay private unless you
  choose to include them, and links go without the tracking tokens apps add to them.
- **Add a friend's saves.** Opening a friend's link shows a preview of what's inside; pick what you want and
  it's added to your library (a shared collection or library arrives as "from Sam" collections). Opening the
  same share again later brings in what your friend changed, without duplicating anything or undoing your own
  edits. Share files can be opened from Settings or the Collections screen, shared straight to the installed
  app from a chat app's share sheet, or opened with the app on desktop.
- **Offline, private, yours.** Everything is stored in IndexedDB on your device. Backup and restore use JSON files.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run typecheck  # type-check the app and the service worker
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build (service worker enabled)
npm run icons      # regenerate PNG icons from public/favicon.svg
```

Stack: React 19, TypeScript, Vite, vite-plugin-pwa (Workbox, with a custom service worker in `src/sw.ts`
for the share target), Dexie (IndexedDB), Leaflet + OpenStreetMap, lucide icons.

## Deploying (making it installable)

The build is static and uses relative paths and hash routing, so it runs from any sub-path over HTTPS.
HTTPS is required for installing the app and for the service worker.

### GitHub Pages (included)

`.github/workflows/deploy.yml` tests and builds every push and pull request. It publishes the repository's
**default branch** to GitHub Pages. To switch it on:

1. Pages needs a **public** repository on GitHub Free; private repositories need GitHub Pro, Team or
   Enterprise. To change visibility: **Settings → General → Danger Zone → Change visibility**.
2. Under **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.
3. Open **Actions → CI & deploy → Run workflow**, or push to the default branch. The app is published at
   `https://<user>.github.io/<repo>/`; for this repo that's **https://amace-wh.github.io/Magpie/**.

Runs before step 2 fail at the deploy step ("Get Pages site failed"). That's expected; run the workflow
again after switching Pages on.

### Other hosts

Netlify, Cloudflare Pages and Vercel all work with private repositories on their free plans. Connect the
repository, then use build command `npm run build` and output directory `dist`. `public/_headers` sets
cache headers for the service worker on Netlify and Cloudflare Pages.

### Installing

- **Android (Chrome, Edge, Samsung Internet):** open the site and tap **Install** on the banner, or use
  **⋮ → Install app**. Magpie then shows up in the Share menu of TikTok, Instagram, YouTube, Maps and others.
- **iPhone / iPad (Safari):** tap **Share → Add to Home Screen**. iOS doesn't let web apps appear in the
  Share menu, so copy a link in any app, then tap **+** in Magpie and paste it.
- **Computer (Chrome, Edge):** click the install icon in the address bar. Magpie opens in its own window and
  can open `.magpie.json` share files.

The installed app keeps working offline and updates itself: when a new version is deployed, it shows
"A new version of Magpie is ready" with an Update button.

## Third-party services

These are all optional. The app works fully offline without them.

| What | Service | When |
| --- | --- | --- |
| Link previews | [noembed.com](https://noembed.com), [microlink.io](https://microlink.io) | After saving a link, and again later for a few saves a day whose preview or picture didn't come (can be disabled) |
| Place details | OpenStreetMap Nominatim (reverse geocoding) | Filling in the city and country of a place you pin; only its coordinates are sent. Background lookups for saves from map links and older saves stop when link previews are off |
| Place search | OpenStreetMap Nominatim | When you search for a location, and in the background for the place a save's caption names (only that name is sent; stops when link previews are off) |
| Map tiles | OpenStreetMap | When viewing a map |
| Original post players | YouTube (youtube-nocookie.com), Vimeo, TikTok, Instagram, X, Threads, Spotify, Apple Music, SoundCloud, Reddit, Pinterest, Facebook, Dailymotion, Loom, Twitch | Only when you tap to load the original post or video on a save (while link previews are on, a YouTube save shows its thumbnail from i.ytimg.com before that) |
| Sharing | The chat app you pick (WhatsApp, Telegram, …) | Only when you share; the saves travel inside the link or file, never through a Magpie server |
