// Shelf Speaker: a Cast receiver that plays a live PCM stream from a TV on the same home network,
// with as little buffering as it can get away with. It only ever connects to private (home
// network) addresses, and only when a Cast sender on the network asks it to.
'use strict';

const NS = 'urn:x-cast:com.officetv.shelf';
// Home-network addresses only: 10.x, 172.16-31.x, 192.168.x.
const ALLOWED = /^wss?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d{1,5})?(\/[\w\-./]*)?$/;

const context = cast.framework.CastReceiverContext.getInstance();
let ctx = null;          // AudioContext
let ws = null;
let nextTime = 0;        // where the next chunk is scheduled, on the AudioContext clock
let target = 0.1;        // seconds held in reserve
let rate = 48000, channels = 2;
let stats = { chunks: 0, underruns: 0, errors: [] };
let lastTs = 0;

function report(extra) {
  const msg = Object.assign({
    type: 'stats',
    ws: ws ? ws.readyState : -1,
    audio: ctx ? ctx.state : 'none',
    sampleRate: ctx ? ctx.sampleRate : 0,
    baseLatency: ctx && ctx.baseLatency !== undefined ? ctx.baseLatency : null,
    outputLatency: ctx && ctx.outputLatency !== undefined ? ctx.outputLatency : null,
    worklet: typeof AudioWorkletNode !== 'undefined',
    ahead: ctx ? Math.max(0, nextTime - ctx.currentTime) : 0,
    chunks: stats.chunks,
    underruns: stats.underruns,
    errors: stats.errors.slice(-5),
    ts: lastTs,
  }, extra || {});
  try { context.sendCustomMessage(NS, undefined, msg); } catch (e) { /* no senders */ }
}

function fail(what) {
  stats.errors.push(String(what).slice(0, 200));
  report();
}

function connect(url) {
  if (typeof url !== 'string' || !ALLOWED.test(url)) { fail('refused address'); return; }
  if (ws) { try { ws.close(); } catch (e) {} }
  try {
    ws = new WebSocket(url);
  } catch (e) { fail('websocket: ' + e.message); return; }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => report({ event: 'open' });
  ws.onerror = () => fail('websocket error');
  ws.onclose = (e) => report({ event: 'close', code: e.code });
  ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) (mse ? playAac(e.data) : play(e.data)); };
}

// AAC mode (no Web Audio on Cast speakers): ADTS frames fed to the device's own player through
// Media Source Extensions, keeping only [target] seconds queued ahead of what's playing.
let mse = null;          // { audio, ms, sb, queue, waiting, seeks }
function startAac() {
  const audio = document.createElement('audio');
  const ms = new MediaSource();
  mse = { audio: audio, ms: ms, sb: null, queue: [], waiting: 0, seeks: 0, started: false };
  audio.addEventListener('waiting', () => { if (mse) mse.waiting++; });
  audio.addEventListener('error', () => fail('player error ' + (audio.error ? audio.error.code : '?')));
  ms.addEventListener('sourceopen', () => {
    try {
      mse.sb = ms.addSourceBuffer('audio/aac');
      mse.sb.mode = 'sequence';
      mse.sb.addEventListener('updateend', pump);
    } catch (e) { fail('sourcebuffer: ' + e.message); }
  });
  audio.src = URL.createObjectURL(ms);
  document.body.appendChild(audio);
}
function pump() {
  if (!mse || !mse.sb || mse.sb.updating || mse.queue.length === 0) return;
  const n = mse.queue.reduce((a, b) => a + b.byteLength, 0);
  const all = new Uint8Array(n);
  let o = 0;
  for (const b of mse.queue) { all.set(new Uint8Array(b), o); o += b.byteLength; }
  mse.queue = [];
  try { mse.sb.appendBuffer(all); } catch (e) { fail('append: ' + e.message); }
}
function aheadAac() {
  if (!mse || !mse.sb) return 0;
  const b = mse.audio.buffered;
  return b.length ? b.end(b.length - 1) - mse.audio.currentTime : 0;
}
function playAac(buf) {
  if (!mse || buf.byteLength < 9) return;
  lastTs = new DataView(buf).getFloat64(0, true);
  mse.queue.push(buf.slice(8));
  pump();
  stats.chunks++;
  if (!mse.started && aheadAac() >= target) {
    mse.started = true;
    mse.audio.play().catch((e) => fail('play: ' + e.message));
  }
  if (stats.chunks % 12 === 0) steerAac();
}
function steerAac() {
  const a = mse.audio, b = a.buffered;
  if (!b.length || !mse.started) return;
  const end = b.end(b.length - 1);
  // A burst or a stall left too much queued: jump forward to [target] from the end.
  if (end - a.currentTime > target + 0.12) {
    a.currentTime = end - target;
    mse.seeks++;
  }
  // Keep the buffer from growing without end.
  if (!mse.sb.updating && b.start(0) < a.currentTime - 20) {
    try { mse.sb.remove(0, a.currentTime - 10); } catch (e) {}
  }
  report({ mode: 'aac', ahead: end - a.currentTime, waiting: mse.waiting, seeks: mse.seeks, rs: a.readyState });
}

// Each message: 8-byte little-endian float64 (the sender's clock, ms), then 16-bit PCM, interleaved.
function play(buf) {
  if (!ctx || buf.byteLength < 8 + 2 * channels) return;
  const view = new DataView(buf);
  lastTs = view.getFloat64(0, true);
  const frames = Math.floor((buf.byteLength - 8) / (2 * channels));
  const audio = ctx.createBuffer(channels, frames, rate);
  for (let c = 0; c < channels; c++) {
    const out = audio.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] = view.getInt16(8 + (i * channels + c) * 2, true) / 32768;
  }
  const now = ctx.currentTime;
  if (nextTime < now) {
    // Ran dry (or just starting): pick up again [target] from now.
    if (stats.chunks > 0) stats.underruns++;
    nextTime = now + target;
  } else if (nextTime - now > target + 0.15) {
    // Too far ahead (a burst arrived): let this chunk go, to come back to the target.
    stats.chunks++;
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(ctx.destination);
  src.start(nextTime);
  nextTime += frames / rate;
  stats.chunks++;
  if (stats.chunks % 25 === 0) report();
}

context.addCustomMessageListener(NS, (event) => {
  const m = event.data || {};
  if (m.type === 'connect') {
    rate = [16000, 22050, 24000, 32000, 44100, 48000].includes(m.rate) ? m.rate : 48000;
    channels = m.channels === 1 ? 1 : 2;
    target = typeof m.target === 'number' && m.target >= 0.02 && m.target <= 2 ? m.target : 0.1;
    stats = { chunks: 0, underruns: 0, errors: [] };
    if (m.mode === 'aac') {
      try { startAac(); } catch (e) { fail('aac: ' + e.message); return; }
    } else {
      try {
        if (!ctx) ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
        if (ctx.state !== 'running') ctx.resume();
      } catch (e) { fail('audio: ' + e.message); return; }
      nextTime = 0;
    }
    connect(m.url);
  } else if (m.type === 'target') {
    if (typeof m.target === 'number' && m.target >= 0.02 && m.target <= 2) target = m.target;
  } else if (m.type === 'caps') {
    // What this device can play with: Web Audio, and Media Source Extensions with which formats.
    const ms = typeof MediaSource !== 'undefined';
    const types = ['audio/webm; codecs="opus"', 'audio/webm; codecs="pcm"', 'audio/mp4; codecs="mp4a.40.2"',
      'audio/mp4; codecs="opus"', 'audio/mp4; codecs="flac"', 'audio/mpeg', 'audio/aac'];
    const supported = ms ? types.filter((t) => { try { return MediaSource.isTypeSupported(t); } catch (e) { return false; } }) : [];
    report({ event: 'caps', caps: {
      AudioContext: typeof AudioContext, webkitAudioContext: typeof webkitAudioContext,
      MediaSource: ms, ManagedMediaSource: typeof ManagedMediaSource !== 'undefined',
      Audio: typeof Audio, WebSocket: typeof WebSocket, WebTransport: typeof WebTransport,
      RTCPeerConnection: typeof RTCPeerConnection, msTypes: supported,
      ua: String(navigator.userAgent).slice(0, 160),
    } });
  } else if (m.type === 'ping') {
    report({ event: 'pong', echo: typeof m.t === 'number' ? m.t : 0 });
  }
});

const options = new cast.framework.CastReceiverOptions();
options.disableIdleTimeout = true;
options.skipPlayersLoad = true;
options.customNamespaces = { [NS]: cast.framework.system.MessageType.JSON };
context.start(options);
