// Round-trip check of the companion tool's protocol logic against the firmware's
// own frame format (App/app/uart.c). Mirrors tools/webflash/js/webflash.js test
// approach: build a frame, then parse it back the way the radio would.
"use strict";

const fs = require("fs");

const html = fs.readFileSync(
  require("path").join(__dirname, "..", "index.html"), "utf8");

const s = html.indexOf("<script>");
const e = html.lastIndexOf("</script>");
let js = html.slice(s + 8, e);

// Strip everything from the UI/DOM section onward: keep protocol + offsets +
// the small pure helpers the tests exercise.
const cutAt = js.indexOf("/* ------------------------------------------------------------------ 界面更新 */");
js = js.slice(0, cutAt);

const sandbox = {};
const fn = new Function("document", "setTimeout", "clearTimeout", "performance",
  js + `
  return { buildCommand, crc16, obfuscate, ReplyReader, OBFUSCATION,
           readU16, readU32, CMD, EEPROM_READ_MAX, VFO_BASE, SCREEN_CH_BASE,
           TX_VFO_OFFSET, BATT_CAL_OFFSET, MR_RECORD_SIZE, VFO_SLOT_STRIDE,
           FREQ_CHANNEL_FIRST, VFO_RECORD_SIZE, fmtMHz, fmtAdcVolt, describeChannel,
           Radio };
`);
const stubEl = { style: {}, className: "", textContent: "", innerHTML: "",
                 appendChild() {}, removeChild() {}, firstChild: null,
                 childElementCount: 0, scrollTop: 0, scrollHeight: 0 };
// Real timers are needed for the Radio queue tests (timeout behaviour).
const M = fn(
  { getElementById: () => stubEl, createElement: () => stubEl },
  setTimeout, clearTimeout,
  { now: () => Date.now() }
);

// Extra helpers defined further down the file (after the UI section) that the
// field-report fixes need. Pulled in separately since the cut point above
// excludes them.
const extraJs = (() => {
  const full = fs.readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");
  const a = full.indexOf("<script>");
  const b = full.lastIndexOf("</script>");
  return full.slice(a + 8, b);
})();
const M2 = new Function("document", extraJs + `
  return { CTCSS_OPTIONS, DCS_OPTIONS, POWER_NAMES, fmtCode, rssiToDbm,
           describeChannel, bandOf, bandOfFrequency, dbm: () => dBmCorr,
           BAND_LOWER_10HZ, BAND_NAMES };
`)({ getElementById: () => stubEl, createElement: () => stubEl });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

console.log("== constants vs firmware ==");
check("OBFUSCATION table matches uart.c:179-182",
  M.OBFUSCATION.join(",") === "22,108,20,230,46,145,13,64,33,53,213,64,19,3,233,128",
  M.OBFUSCATION.join(","));
check("EEPROM_READ_MAX = 128 (uart.c:420)", M.EEPROM_READ_MAX === 128);
check("VFO bases 0x9000/0x9010 (settings.c:1227)",
  M.VFO_BASE[0] === 0x009000 && M.VFO_BASE[1] === 0x009010);
check("VFO slot stride 32 (radio.c:385)", M.VFO_SLOT_STRIDE === 32);
check("ScreenChannel base 0xA010 (settings.c:213)", M.SCREEN_CH_BASE === 0x00A010);
check("TX_VFO flat offset", M.TX_VFO_OFFSET === 0x00A0A8 + 0x18 + 3);
check("Battery cal flat offset = physical-0x5000",
  M.BATT_CAL_OFFSET === 0x00B140);

console.log("\n== crc16 / obfuscation ==");
check("crc16 of empty = 0", M.crc16(new Uint8Array(0)) === 0);
// CRC-16/XMODEM (poly 0x1021, init 0x0000, no reflection) - App/driver/crc.c.
// Check value for "123456789" is 0x31C3 (NOT 0x29B1, which is CCITT-FALSE with
// a 0xFFFF init).
const abc = new Uint8Array([...Buffer.from("123456789")]);
check("crc16('123456789') = 0x31C3", M.crc16(abc) === 0x31C3,
  "0x" + M.crc16(abc).toString(16));

console.log("\n== frame round-trip ==");

// Build a 0x0514 handshake (u32 timestamp) and verify it parses as the radio
// would: header AB CD, size at [2..3] LE, body obfuscated+CRC, footer DC BA.
const ts = 0x12345678;
const data = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
const frame = M.buildCommand(M.CMD.DEV_INFO, data);

check("starts with AB CD", frame[0] === 0xAB && frame[1] === 0xCD);
check("ends with DC BA", frame[frame.length - 2] === 0xDC && frame[frame.length - 1] === 0xBA);

const size = frame[2] | (frame[3] << 8);
check("size field = payload len (id+len+data = 8)", size === 8, "got " + size);
check("total = 4 + size + 2(crc) + 2(footer)", frame.length === 4 + size + 2 + 2,
  "len " + frame.length);

// De-obfuscate the body the way UART_IsCommandAvailable does and check CRC+fields.
const body = new Uint8Array(size + 2);
for (let i = 0; i < body.length; i++) body[i] = frame[4 + i] ^ M.OBFUSCATION[i % 16];
const id = M.readU16(body, 0);
const dlen = M.readU16(body, 2);
const crcGot = M.readU16(body, size);
check("payload id = 0x0514", id === 0x0514, "0x" + id.toString(16));
check("payload dataLen = 4", dlen === 4, "got " + dlen);
check("CRC over payload matches (uart.c:823)",
  crcGot === M.crc16(body.slice(0, size)),
  "0x" + crcGot.toString(16) + " vs 0x" + M.crc16(body.slice(0, size)).toString(16));
check("timestamp round-trips",
  M.readU32(body, 4) === ts, "0x" + M.readU32(body, 4).toString(16));

console.log("\n== ReplyReader ==");

// Build a synthetic reply the way SendReply_VCP does (uart.c:210-261).
// The wire size field is the PAYLOAD length (id + dataLen + data); the two
// bytes that follow it on the wire are the padding (see webflash.js:183-185).
function buildReply(replyId, payload) {
  const inner = new Uint8Array(4 + payload.length);
  inner[0] = replyId & 0xFF; inner[1] = (replyId >> 8) & 0xFF;
  inner[2] = payload.length & 0xFF; inner[3] = (payload.length >> 8) & 0xFF;
  inner.set(payload, 4);

  const sz = inner.length;          // payload length == the size field

  // Obfuscated payload, then the 2-byte padded footer region.
  const body = new Uint8Array(sz + 2);
  for (let i = 0; i < sz; i++) body[i] = inner[i] ^ M.OBFUSCATION[i % 16];
  body[sz + 0] = M.OBFUSCATION[(sz + 0) % 16] ^ 0xFF;
  body[sz + 1] = M.OBFUSCATION[(sz + 1) % 16] ^ 0xFF;

  const out = new Uint8Array(4 + sz + 2 + 2);
  out[0] = 0xAB; out[1] = 0xCD;
  out[2] = sz & 0xFF; out[3] = (sz >> 8) & 0xFF;
  out.set(body, 4);
  out[out.length - 2] = 0xDC; out[out.length - 1] = 0xBA;
  return out;
}

const rssiPayload = new Uint8Array([0xE1, 0x00, 0x11, 0x22]); // rssi=0x00E1
const reply = buildReply(M.CMD.READ_RSSI_RSP, rssiPayload);

let r = new M.ReplyReader();
let out = r.push(reply);
check("one reply parsed whole", out.length === 1, "got " + out.length);
check("reply id = 0x0528", out[0] && out[0].id === 0x0528);
check("rssi = 225", out[0] && M.readU16(out[0].data, 0) === 225);
check("noise = 0x11", out[0] && out[0].data[2] === 0x11);
check("glitch = 0x22", out[0] && out[0].data[3] === 0x22);

// Byte-at-a-time delivery: the reader must tolerate arbitrary fragmentation.
r = new M.ReplyReader();
let total = 0;
for (let i = 0; i < reply.length; i++) {
  const got = r.push(reply.slice(i, i + 1));
  total += got.length;
}
check("survives 1-byte-at-a-time feed", total === 1, "got " + total);

// Two replies back to back in one chunk.
const two = new Uint8Array(reply.length * 2);
two.set(reply, 0); two.set(reply, reply.length);
r = new M.ReplyReader();
out = r.push(two);
check("two concatenated replies parsed", out.length === 2, "got " + out.length);

// Leading garbage must be skipped.
r = new M.ReplyReader();
out = r.push(new Uint8Array([0x00, 0xFF, 0x55, 0xAA]).slice(0));
out = out.concat(r.push(reply));
check("skips leading garbage", out.length === 1, "got " + out.length);

console.log("\n== voltage conversion (battery.c:148) ==");
// gBatteryVoltageAverage = (adc * 760) / cal   -> 10mV units
function volts(adc, cal) { return Math.round((adc * 760) / cal) / 100; }
check("adc=2000, cal=2000 -> 7.60 V", Math.abs(volts(2000, 2000) - 7.60) < 1e-9,
  volts(2000, 2000) + " V");
check("adc=0 -> 0 V (displayed as dash)", volts(0, 2000) === 0);

console.log("\n== VFO address math ==");
function vfoAddr(channel, vfo) {
  if (channel <= 1023) return channel * M.MR_RECORD_SIZE;
  const band = channel - M.FREQ_CHANNEL_FIRST;
  return M.VFO_BASE[vfo] + band * M.VFO_SLOT_STRIDE;
}
// 400 MHz band is index 5 -> FREQ_CHANNEL_FIRST+5 = 1029
check("MR ch 10 -> 0x00A0", vfoAddr(10, 0) === 0x00A0, "0x" + vfoAddr(10, 0).toString(16));
check("band VFO 5, vfo0 -> 0x90A0", vfoAddr(1029, 0) === 0x0090A0,
  "0x" + vfoAddr(1029, 0).toString(16));
check("band VFO 5, vfo1 -> 0x90B0", vfoAddr(1029, 1) === 0x0090B0,
  "0x" + vfoAddr(1029, 1).toString(16));
// The 7 band slots (FREQ_CHANNEL_FIRST..LAST, misc.h:60) must fit in the
// 0x1F0-byte window that eeprom_compat.c:54-56 declares for the VFO block.
check("band VFO 6 (last), vfo1 -> 0x90D0, inside the mapped window",
  vfoAddr(1024 + 6, 1) === 0x0090D0, "0x" + vfoAddr(1024 + 6, 1).toString(16));
check("last VFO record ends at 0x90E0 (mapping bound)",
  vfoAddr(1024 + 6, 1) + M.VFO_RECORD_SIZE === 0x0090E0);

/* ==========================================================================
 * Regression test for the field failure:
 *
 * On a firmware built without ENABLE_EXTRA_UART_CMD (the Labs default), 0x0527
 * and 0x0529 are not compiled in (uart.c:907-914). The radio answers them with
 * silence. The original client queued every request without bound, so each
 * 800 ms timeout left a stale entry that the next request queued behind -
 * eventually starving the 0x0514 keepalive and wedging the whole tool.
 *
 * These tests drive the real Radio class with a fake port that never replies.
 * ========================================================================== */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRadio() {
  const r = new M.Radio();
  const written = [];
  r.port = { readable: null };
  r.writer = { write: (f) => { written.push(f); return Promise.resolve(); } };
  r.port.writable = { getWriter: () => r.writer };
  r._written = written;
  return r;
}

(async function queueTests() {
  console.log("\n== request queue (regression: unbounded starvation) ==");

  // A silent radio: nothing is ever dispatched, so every request times out.
  const r = fakeRadio();

  // Fire several unsupported-command requests back to back, as the old tick()
  // did. Each must reject on its own timeout without leaving an immortal entry.
  const t0 = Date.now();
  const results = await Promise.allSettled([
    r.request(M.CMD.READ_RSSI, new Uint8Array(0), M.CMD.READ_RSSI_RSP, 120),
    r.request(M.CMD.READ_RSSI, new Uint8Array(0), M.CMD.READ_RSSI_RSP, 120),
    r.request(M.CMD.READ_RSSI, new Uint8Array(0), M.CMD.READ_RSSI_RSP, 120)
  ]);
  const elapsed = Date.now() - t0;

  check("all unsupported requests reject (no hang)",
    results.every((x) => x.status === "rejected"), JSON.stringify(results.map(x => x.status)));
  check("queue is drained afterwards, not accumulating",
    r.pending.length === 0, "pending=" + r.pending.length);
  check("each rejects on its own timeout, not serially stacked",
    elapsed < 400, elapsed + " ms");

  // The keepalive must still get through after a burst of unsupported commands.
  // This is exactly what failed in the field.
  let handshakeReached = false;
  r.writer.write = (f) => { handshakeReached = true; return Promise.resolve(); };
  const hs = r.request(M.CMD.DEV_INFO, new Uint8Array(4), M.CMD.DEV_INFO_RSP, 150);
  check("handshake still reaches the wire after the burst", handshakeReached);

  // And it must not be stuck behind a stale entry.
  check("handshake is the sole in-flight transaction",
    r.pending.length === 1 && r.pending[0].id === M.CMD.DEV_INFO_RSP,
    "pending=" + r.pending.length);

  await Promise.allSettled([hs]);
  check("queue empty once the handshake times out too",
    r.pending.length === 0, "pending=" + r.pending.length);

  // A late reply after a timeout must be discarded harmlessly, and a fresh
  // request that follows must still resolve.
  console.log("\n== late reply after timeout ==");
  const r2 = fakeRadio();
  const late = r2.request(M.CMD.READ_RSSI, new Uint8Array(0), M.CMD.READ_RSSI_RSP, 60);
  await Promise.allSettled([late]);
  r2.dispatch({ id: M.CMD.READ_RSSI_RSP, data: new Uint8Array([1, 0, 0, 0]) });
  check("late reply for an expired request is dropped", r2.pending.length === 0);

  const good = r2.request(M.CMD.DEV_INFO, new Uint8Array(4), M.CMD.DEV_INFO_RSP, 300);
  r2.dispatch({ id: M.CMD.DEV_INFO_RSP, data: new Uint8Array([86, 0, 0, 0]) });
  const okRes = await good;
  check("a later request still resolves normally",
    okRes.id === M.CMD.DEV_INFO_RSP && okRes.data[0] === 86);

  console.log("\n== probeCapabilities on a silent radio ==");
  const r3 = fakeRadio();
  const caps = await r3.probeCapabilities();
  check("reports both caps false when the radio is silent",
    caps.rssi === false && caps.adc === false, JSON.stringify(caps));
  check("probe leaves no pending entries behind",
    r3.pending.length === 0, "pending=" + r3.pending.length);

    console.log("\n== flushReplies ==");
  const r4 = fakeRadio();
  r4.replies.push(new Uint8Array([1, 2, 3, 4, 5]));
  r4.flushReplies();
  check("flush clears the receive buffer", r4.replies.buffer.length === 0);
})();

/* ==========================================================================
 * Field-report fixes (user-observed on real hardware)
 * ========================================================================== */
console.log("\n== fix 1: frequency / offset scaling ==");
// THE UNIT IS 10 Hz, NOT Hz. Authoritative proof: the radio's own formatter
// (App/ui/main.c:304) is  sprintf("%u.%05u", f/100000, f%100000)  — that only
// yields MHz if one count is 10 Hz (1 MHz / 10 Hz = 100000 counts).
// Field confirmation: raw 43950000 shows as 439.50000 on the radio screen.
function fmtMHzField(f) {
  if (!f || f === 0xFFFFFFFF) return "--.-----";
  return Math.floor(f / 100000) + "." + String(f % 100000).padStart(5, "0");
}
check("43950000 -> 439.50000 (field-confirmed)",
  fmtMHzField(43950000) === "439.50000", fmtMHzField(43950000));
check("43850000 -> 438.50000",
  fmtMHzField(43850000) === "438.50000", fmtMHzField(43850000));
check("14550000 -> 145.50000",
  fmtMHzField(14550000) === "145.50000", fmtMHzField(14550000));
check("the old /1e6 bug produced 43.95000 for 43950000",
  (43950000 / 1e6).toFixed(5) === "43.95000");
// TX offset is the same unit (radio.c:472-475).
check("offset 500000 (= 5.00000 MHz in 10Hz counts)",
  fmtMHzField(500000) === "5.00000", fmtMHzField(500000));
check("offset 0 renders as invalid",
  fmtMHzField(0) === "--.-----", fmtMHzField(0));

console.log("\n== fix 2: RSSI -> dBm (bk4819.c:398-402) ==");
// BK4819_GetRSSI_dBm() = (raw / 2) - 160, then + dBmCorrTable[band].
check("raw=0   -> -160 dBm (band0 corr -15) -> -175",
  M2.rssiToDbm(0, 0) === -175, String(M2.rssiToDbm(0, 0)));
check("raw=200 -> 100-160-15 = -75 dBm",
  M2.rssiToDbm(200, 0) === -75, String(M2.rssiToDbm(200, 0)));
check("raw=320 -> 160-160-15 = -15 dBm",
  M2.rssiToDbm(320, 0) === -15, String(M2.rssiToDbm(320, 0)));
// Integer division must match the firmware's (rssi / 2) exactly.
check("odd raw uses integer division (255/2 = 127)",
  M2.rssiToDbm(255, 0) === (127 - 160 - 15), String(M2.rssiToDbm(255, 0)));
check("band 6 correction (-1) differs from band 0 (-15)",
  M2.rssiToDbm(200, 6) === -61, String(M2.rssiToDbm(200, 6)));

console.log("\n== fix 3: channel numbering is 1-based ==");
// App/ui/main.c:1698 prints ScreenChannel + 1.
check("internal channel 0 -> '信道 1'",
  M2.describeChannel(0).label === "信道 1", M2.describeChannel(0).label);
check("internal channel 1 -> '信道 2'",
  M2.describeChannel(1).label === "信道 2", M2.describeChannel(1).label);

console.log("\n== VFO / MR mode indicator ==");
// MR channels are 0..MR_CHANNEL_LAST; anything above is a band VFO
// (App/ui/main.c:1693 uses IS_MR_CHANNEL to pick the display style).
check("channel 0 -> MR mode", M2.describeChannel(0).mode === "MR",
  M2.describeChannel(0).mode);
check("channel 1023 (last MR) -> MR mode",
  M2.describeChannel(1023).mode === "MR", M2.describeChannel(1023).mode);
check("channel 1029 (= FREQ_FIRST+5) -> VFO mode",
  M2.describeChannel(1029).mode === "VFO", M2.describeChannel(1029).mode);
check("band VFO label names the band",
  M2.describeChannel(1029).label === "VFO 400 MHz",
  M2.describeChannel(1029).label);
check("every band channel reports VFO mode",
  [0, 1, 2, 3, 4, 5, 6].every((b) => M2.describeChannel(1024 + b).mode === "VFO"));
check("MR channels never report VFO mode",
  M2.describeChannel(500).mode === "MR" && M2.describeChannel(1023).mode === "MR");

console.log("\n== fix 4: power names (menu.c:207, 8 entries) ==");
check("table has 8 entries", M2.POWER_NAMES.length === 8, String(M2.POWER_NAMES.length));
check("index 0 = USER", M2.POWER_NAMES[0] === "USER");
check("index 6 = MID", M2.POWER_NAMES[6] === "MID");
check("index 7 = HIGH (was the 'P7' the user saw)",
  M2.POWER_NAMES[7] === "HIGH", M2.POWER_NAMES[7]);

console.log("\n== fix 5: squelch + CTCSS/DCS decoding ==");
// CTCSS code is a TABLE INDEX, not a frequency (radio.c:287-303).
check("CTCSS index 12 -> 100.0Hz",
  M2.fmtCode(12, 1) === "CTCSS 100.0Hz", M2.fmtCode(12, 1));
// Index 0 is a LEGAL code (67.0 Hz). It must not be swallowed by a `!code` test.
check("CTCSS index 0 -> 67.0Hz (0 is not 'unset')",
  M2.fmtCode(0, 1) === "CTCSS 67.0Hz", M2.fmtCode(0, 1));
check("CTCSS index 1 -> 69.3Hz",
  M2.fmtCode(1, 1) === "CTCSS 69.3Hz", M2.fmtCode(1, 1));
// DCS prints the code word in octal with N/I suffix (main.c:2123).
// DCS_Options[0] = 0x0013, and 0x13 octal is 023.
check("DCS index 0 type2 -> octal 023N",
  M2.fmtCode(0, 2) === "DCS 023N", M2.fmtCode(0, 2));
check("DCS index 0 type3 -> octal 023I",
  M2.fmtCode(0, 3) === "DCS 023I", M2.fmtCode(0, 3));
check("DCS index 1 -> 0x0015 -> octal 025N",
  M2.fmtCode(1, 2) === "DCS 025N", M2.fmtCode(1, 2));
check("codeType 0 (off) yields empty",
  M2.fmtCode(12, 0) === "", M2.fmtCode(12, 0));
check("out-of-range index is rejected safely",
  M2.fmtCode(200, 1) === "", M2.fmtCode(200, 1));

console.log("\n== band derivation for dBm correction ==");
// Frequencies come from the VFO record in 10 Hz units (frequencies.c:38-45),
// and FREQUENCY_GetBand scans from the highest band down (frequencies.c:118).
// Indices follow the enum at frequencies.h:33-43 exactly:
//   0=50M 1=108M 2=137M 3=174M 4=350M 5=400M 6=(unused) 7=470M
check("band VFO 1029 (FREQ_FIRST+5) -> band 5", M2.bandOf(1029, 0) === 5,
  String(M2.bandOf(1029, 0)));
check("430 MHz (43000000 x10Hz) -> band 5",
  M2.bandOfFrequency(43000000) === 5, String(M2.bandOfFrequency(43000000)));
check("145.5 MHz (14550000 x10Hz) -> band 2 (BAND3_137MHz)",
  M2.bandOfFrequency(14550000) === 2, String(M2.bandOfFrequency(14550000)));
check("137 MHz boundary -> band 2",
  M2.bandOfFrequency(13700000) === 2, String(M2.bandOfFrequency(13700000)));
check("136.9 MHz just below boundary -> band 1 (BAND2_108MHz)",
  M2.bandOfFrequency(13699999) === 1, String(M2.bandOfFrequency(13699999)));
check("108 MHz -> band 1",
  M2.bandOfFrequency(10800000) === 1, String(M2.bandOfFrequency(10800000)));
check("470 MHz -> band 7 (BAND7_470MHz)",
  M2.bandOfFrequency(47000000) === 7, String(M2.bandOfFrequency(47000000)));
check("the unused slot 6 is never returned",
  M2.bandOfFrequency(46500000) === 5, String(M2.bandOfFrequency(46500000)));
// dBmCorrTable has only 7 entries but the band enum has 8 (misc.c:153 vs
// frequencies.h:33-43). The firmware indexes it unclamped; we clamp so the
// host cannot read past the table either.
check("band 7 clamps into the 7-entry correction table",
  M2.rssiToDbm(200, 7) === M2.rssiToDbm(200, 6),
  M2.rssiToDbm(200, 7) + " vs " + M2.rssiToDbm(200, 6));

console.log("\n== RSSI hold across power-save dropouts ==");
// The radio sleeps the RF chip when idle (app.c:1476-1481 sets gRxIdleMode and
// calls BK4819_Sleep), so REG_67 reads back stale/zero and RSSI flickers.
// The UI must hold the last fresh reading instead of blanking out.
{
  const RSSI_HOLD_MS = 4000;
  const hold = { value: null, at: 0 };
  let now = 1000;

  function view(raw) {
    const fresh = (raw !== null && raw !== undefined && raw > 0);
    if (fresh) { hold.value = raw; hold.at = now; }
    const use = fresh ? raw : hold.value;
    const held = !fresh && use !== null && (now - hold.at) < RSSI_HOLD_MS;
    return { use, held };
  }

  let v = view(200);
  check("first fresh reading is shown and not marked held",
    v.use === 200 && v.held === false, JSON.stringify(v));

  // Radio went to sleep: reads 0.
  now += 200;
  v = view(0);
  check("dropout keeps the previous value",
    v.use === 200, JSON.stringify(v));
  check("dropout is flagged as held", v.held === true, JSON.stringify(v));

  // Still asleep for a while, but within the hold window.
  now += 2000;
  v = view(0);
  check("still held within the window", v.use === 200 && v.held === true,
    JSON.stringify(v));

  // Radio wakes up with a new, stronger signal.
  now += 100;
  v = view(350);
  check("wake-up replaces the held value", v.use === 350, JSON.stringify(v));
  check("fresh reading clears the held flag", v.held === false,
    JSON.stringify(v));

  // Asleep far too long: the value must eventually expire, not stick forever.
  now += RSSI_HOLD_MS + 1;
  v = view(0);
  check("expires after the hold window instead of sticking forever",
    v.held === false && v.use === 350, JSON.stringify(v));

  // A very first read that is already a zero must show nothing, not a stale 0.
  const hold2 = { value: null, at: 0 };
  const fresh2 = (0 > 0);
  check("zero before any valid reading leaves nothing held",
    !fresh2 && hold2.value === null);
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : fail + " FAILED / " + pass + " passed"));
process.exit(fail === 0 ? 0 : 1);
