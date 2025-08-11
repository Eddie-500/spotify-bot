// spotify.js
import axios from "axios";
import qs from "qs";
import fs from "fs";

const TOKEN_FILE = "storage.json";

// --- Simple JSON storage (demo) ---
function loadState() {
  try { 
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8")); 
  } catch { 
    return {}; 
  }
}

function saveState(obj) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2));
}

export const state = loadState();

export function setState(patch) {
  Object.assign(state, patch);
  saveState(state);
}

// --- Spotify endpoints ---
const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";
const SPOTIFY_API = "https://api.spotify.com/v1";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI
} = process.env;

export function authUrl(scopes, stateParam) {
  const params = qs.stringify({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: scopes.join(" "),
    state: stateParam,
    show_dialog: "false"
  });
  return `${SPOTIFY_ACCOUNTS}/authorize?${params}`;
}

export async function exchangeCodeForTokens(code) {
  const body = qs.stringify({
    grant_type: "authorization_code",
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI
  });

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

  const { data } = await axios.post(`${SPOTIFY_ACCOUNTS}/api/token`, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${auth}`
    }
  });

  setState({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expires_at: Date.now() + (data.expires_in - 60) * 1000
  });
}

export async function refreshAccessTokenIfNeeded() {
  if (!state.refresh_token) return;
  if (state.access_token && Date.now() < (state.token_expires_at || 0)) return;

  const body = qs.stringify({
    grant_type: "refresh_token",
    refresh_token: state.refresh_token
  });

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

  const { data } = await axios.post(`${SPOTIFY_ACCOUNTS}/api/token`, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${auth}`
    }
  });

  setState({
    access_token: data.access_token,
    token_expires_at: Date.now() + (data.expires_in - 60) * 1000
  });
}

async function api(method, url, { params, data, deviceId } = {}) {
  await refreshAccessTokenIfNeeded();
  if (!state.access_token) throw new Error("Not authenticated with Spotify");

  const headers = { Authorization: `Bearer ${state.access_token}` };
  const conf = { method, url: `${SPOTIFY_API}${url}`, headers, params, data };
  if (deviceId) conf.params = { ...(params || {}), device_id: deviceId };

  const res = await axios(conf).catch(err => {
    const e = err.response?.data || err;
    throw new Error(typeof e === "string" ? e : JSON.stringify(e));
  });
  return res?.data;
}

// --- Public helpers used by server ---
export const me = () => api("get", "/me");

export const getPlaylists = (limit = 50, offset = 0) =>
  api("get", "/me/playlists", { params: { limit, offset } });

export const getDevices = () => api("get", "/me/player/devices");

export const getPlayback = () => api("get", "/me/player");

export const startPlayback = ({ context_uri, uris, position_ms = 0, offset, device_id }) =>
  api("put", "/me/player/play", {
    data: { context_uri, uris, position_ms, offset },
    deviceId: device_id
  });

export const pausePlayback = (device_id) =>
  api("put", "/me/player/pause", { deviceId: device_id });

export const transferPlayback = (device_id, play = false) =>
  api("put", "/me/player", { data: { device_ids: [device_id], play } });

export const getPlaylist = (id) => api("get", `/playlists/${id}`);
