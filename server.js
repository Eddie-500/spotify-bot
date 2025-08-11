// server.js
import "dotenv/config";
import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import crypto from "crypto";

import {
  authUrl,
  exchangeCodeForTokens,
  state as store,
  setState,
  getPlaylists,
  getDevices,
  getPlayback,
  startPlayback,
  transferPlayback
} from "./spotify.js";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: crypto.randomBytes(16).toString("hex"),
    resave: false,
    saveUninitialized: true
  })
);

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 10000}`;
const INTERVAL = Number(process.env.MONITOR_INTERVAL || 20) * 1000;

// Scopes needed
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative"
];

// --- UI routes ---
app.get("/", (_req, res) => {
  const authed = Boolean(store.refresh_token);
  res.type("html").send(`
  <html><body style="font-family:system-ui;padding:24px;max-width:800px">
    <h2>Spotify Bot (Educational)</h2>
    <p>Status: ${authed ? "✅ Connected" : "❌ Not connected"}</p>

    ${authed ? `
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <a href="/playlists">Pick playlist</a>
        <a href="/devices">Pick device</a>
        <a href="/bot/on">Start Bot</a>
        <a href="/bot/off">Stop Bot</a>
        <a href="/interrupt/on">Interrupt On</a>
        <a href="/interrupt/off">Interrupt Off</a>
        <a href="/kick">Kick Playback Now</a>
        <a href="/state">View State (JSON)</a>
      </div>
      <p style="margin-top:12px"><small>Tip: keep your target device (desktop app / phone / speaker) signed in and online.</small></p>
    ` : `
      <a href="/login">Login with Spotify</a>
    `}
  </body></html>`);
});

app.get("/login", (req, res) => {
  const s = crypto.randomBytes(12).toString("hex");
  req.session.oauth_state = s;
  res.redirect(authUrl(SCOPES, s));
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauth_state) {
    return res.status(400).send("Invalid OAuth state.");
  }
  try {
    await exchangeCodeForTokens(code);
    res.redirect("/");
  } catch (e) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// --- Playlist/device selection ---
app.get("/playlists", async (_req, res) => {
  try {
    const pl = await getPlaylists(50, 0);
    const links = (pl.items || [])
      .map(p => `<li><a href="/choose/playlist/${p.id}">${escapeHtml(p.name)}</a></li>`)
      .join("");
    res.type("html").send(`<h3>Pick a playlist</h3><ul>${links}</ul><p><a href="/">Back</a></p>`);
  } catch (e) {
    res.status(500).send(`Error loading playlists: ${e.message}`);
  }
});

app.get("/choose/playlist/:id", (req, res) => {
  setState({ selected_playlist_id: req.params.id });
  res.redirect("/state");
});

app.get("/devices", async (_req, res) => {
  try {
    const d = await getDevices();
    const links = (d.devices || [])
      .map(dev => `<li><a href="/choose/device/${dev.id}">${escapeHtml(dev.name)} — ${dev.type}${dev.is_active ? " (active)" : ""}</a></li>`)
      .join("");
    res.type("html").send(`<h3>Pick a device</h3><ul>${links}</ul><p><a href="/">Back</a></p>`);
  } catch (e) {
    res.status(500).send(`Error loading devices: ${e.message}`);
  }
});

app.get("/choose/device/:id", async (req, res) => {
  try {
    setState({ preferred_device_id: req.params.id });
    // Transfer playback (not playing yet) to prime the device
    await transferPlayback(req.params.id, false);
    res.redirect("/state");
  } catch (e) {
    res.status(500).send(`Error choosing device: ${e.message}`);
  }
});

// --- Bot controls ---
app.get("/bot/on", (_req, res) => { setState({ bot_enabled: true, user_interrupt: false }); res.redirect("/state"); });
app.get("/bot/off", (_req, res) => { setState({ bot_enabled: false }); res.redirect("/state"); });

app.get("/interrupt/on", (_req, res) => { setState({ user_interrupt: true }); res.json({ ok: true }); });
app.get("/interrupt/off", (_req, res) => { setState({ user_interrupt: false }); res.json({ ok: true }); });

app.get("/kick", async (_req, res) => {
  try {
    const { selected_playlist_id, preferred_device_id } = store;
    if (!selected_playlist_id || !preferred_device_id) {
      return res.status(400).json({ error: "Select a playlist and device first." });
    }
    await startPlayback({
      context_uri: `spotify:playlist:${selected_playlist_id}`,
      device_id: preferred_device_id
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/state", (_req, res) => res.json(store));

// --- Monitor loop (autonomous playback & user-interruption handling) ---
async function monitorTick() {
  try {
    if (!store.bot_enabled) return;

    const deviceId = store.preferred_device_id || process.env.PREFERRED_DEVICE_ID;
    const playlistId = store.selected_playlist_id;
    if (!deviceId || !playlistId) return;

    const playback = await getPlayback().catch(() => null);
    if (!playback) return;

    // If user is actively listening to a different context/device, respect it
    const differentContext = playback.context?.uri !== `spotify:playlist:${playlistId}`;
    if (!store.user_interrupt && playback.is_playing && differentContext) {
      setState({ user_interrupt: true });
      console.log("[monitor] Detected manual user playback; bot paused itself.");
      return;
    }

    // If user has marked interruption, wait until they stop listening
    if (store.user_interrupt) {
      if (!playback.is_playing) {
        console.log("[monitor] User idle; resuming bot playback.");
        setState({ user_interrupt: false });
        await startPlayback({
          context_uri: `spotify:playlist:${playlistId}`,
          device_id: deviceId
        }).catch(e => console.log("[monitor] startPlayback error:", e.message));
      }
      return;
    }

    // Ensure playback is running on the correct device + playlist
    const isTargetDeviceActive = playback.device?.id === deviceId;
    const isCorrectContext = playback.context?.uri === `spotify:playlist:${playlistId}`;

    if (!playback.is_playing || !isTargetDeviceActive || !isCorrectContext) {
      console.log("[monitor] Reasserting playback on target device & playlist...");
      await startPlayback({
        context_uri: `spotify:playlist:${playlistId}`,
        device_id: deviceId
      }).catch(e => console.log("[monitor] startPlayback error:", e.message));
    }
  } catch (e) {
    console.log("[monitor] Loop error:", e.message);
  }
}

setInterval(monitorTick, INTERVAL);

// --- Helpers ---
function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// --- Start server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Web service listening on ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
