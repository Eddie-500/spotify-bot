# Spotify Render Bot (Educational)

This repo shows how to authenticate with Spotify (OAuth 2.0), list playlists, target a device, and keep a playlist playing automatically with a background monitor loop. Designed to deploy on **Render** as a single web service (no extra worker needed).

> ⚠️ **Requirements & Ethics**
> - Spotify **Premium** is required for playback control via the Web API.
> - Playback always happens on a **real Spotify device** (desktop app, phone, smart speaker) logged into the user’s account.
> - This project is for **education only**. Do not use it to manipulate streams or violate Spotify’s terms.

## Quick Start

1. **Create a Spotify App**
   - https://developer.spotify.com/dashboard
   - Add a Redirect URI (e.g. `https://your-service.onrender.com/callback`).

2. **Configure env**
   - Copy `.env.example` to `.env` and fill in values.
   - For local dev, set `BASE_URL=http://localhost:10000` and `SPOTIFY_REDIRECT_URI=http://localhost:10000/callback`.

3. **Install & Run**
   ```bash
   npm i
   npm start
