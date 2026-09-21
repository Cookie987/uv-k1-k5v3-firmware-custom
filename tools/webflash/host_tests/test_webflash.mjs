/*
 * Host test for tools/webflash.
 *
 * The radio side is simulated straight from App/app/uart.c (frame parser, reply
 * builder, the four command handlers and the "only whole 8-byte groups are
 * stored" rule), so a mistake in the web tool's framing or in the channel codec
 * shows up here rather than on a real radio.
 *
 *   node tools/webflash/host_tests/test_webflash.mjs [cn_font.bin]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBFLASH = path.dirname(HERE);
const REPO = path.resolve(WEBFLASH, "..", "..");
const FONT_BLOB = process.argv[2] || path.join(REPO, "Dondji", "docs", "font", "cn_font.bin");

let failures = 0;

function check(condition, what, detail) {
    if (condition) {
        console.log("ok   " + what);
    } else {
        failures++;
        console.log("FAIL " + what + (detail === undefined ? "" : "  -> " + detail));
    }
}

function bytes(text) {
    return Uint8Array.from(text.split(/\s+/).filter(Boolean).map((t) => parseInt(t, 16)));
}

function hex(data) {
    return Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/* Load the two classic scripts the page uses. */
(new Function(fs.readFileSync(path.join(WEBFLASH, "js", "tables.js"), "utf8")))();
(new Function(fs.readFileSync(path.join(WEBFLASH, "js", "webflash.js"), "utf8")))();
const W = globalThis.WebFlash;
const T = globalThis.WebFlashTables;

// ---------------------------------------------------------------- simulator

const OBFUSCATION = [0x16, 0x6C, 0x14, 0xE6, 0x2E, 0x91, 0x0D, 0x40,
                     0x21, 0x35, 0xD5, 0x40, 0x13, 0x03, 0xE9, 0x80];

function crc16(data) {
    let crc = 0;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff) : ((crc << 1) & 0xffff);
        }
    }
    return crc;
}

function xor(data) {
    return Uint8Array.from(data, (b, i) => b ^ OBFUSCATION[i % 16]);
}

/* UART_IsCommandAvailable(): AB CD | size | obf(payload + crc) | DC BA */
function parseCommand(frame) {
    if (frame[0] !== 0xab || frame[1] !== 0xcd) throw new Error("bad magic");
    const size = frame[2] | (frame[3] << 8);
    if (frame.length !== 4 + size + 2 + 2) {
        throw new Error(`frame length ${frame.length}, expected ${4 + size + 2 + 2}`);
    }
    const body = xor(frame.slice(4, 4 + size + 2));
    if (frame[4 + size + 2] !== 0xdc || frame[4 + size + 3] !== 0xba) throw new Error("bad tail");
    const crc = body[size] | (body[size + 1] << 8);
    if (crc !== crc16(body.slice(0, size))) throw new Error("bad crc");
    const id = body[0] | (body[1] << 8);
    const dataLen = body[2] | (body[3] << 8);
    if (dataLen > size - 4) throw new Error("header size larger than payload");
    return { id, data: body.slice(4, 4 + dataLen) };
}

/* SendReply(): AB CD | size | obf(payload) | pad2 | DC BA */
function buildReply(id, data) {
    const payload = new Uint8Array(4 + data.length);
    payload[0] = id & 0xff;
    payload[1] = (id >> 8) & 0xff;
    payload[2] = data.length & 0xff;
    payload[3] = (data.length >> 8) & 0xff;
    payload.set(data, 4);

    const size = payload.length;
    const pad = Uint8Array.from([OBFUSCATION[size % 16] ^ 0xff, OBFUSCATION[(size + 1) % 16] ^ 0xff]);
    const frame = new Uint8Array(4 + size + 4);
    frame[0] = 0xab;
    frame[1] = 0xcd;
    frame[2] = size & 0xff;
    frame[3] = (size >> 8) & 0xff;
    frame.set(xor(payload), 4);
    frame.set(pad, 4 + size);
    frame[4 + size + 2] = 0xdc;
    frame[4 + size + 3] = 0xba;
    return frame;
}

class FakeRadio {
    constructor() {
        this.eeprom = new Uint8Array(0x10000).fill(0xff);
        this.font = new Uint8Array(T.font.totalSize).fill(0xff);
        this.timestamp = 0;
        this.pending = new Uint8Array(0);
        this.writes = [];              // {offset, length} actually stored
        this.failFontWriteAt = -1;     // offset that throws (interrupted upload)
        this.dropReplies = 0;          // swallow this many replies (lost packet)
        this.silent = false;           // stop answering altogether
        this.commands = [];
    }

    /* Called by the transport with raw host bytes; returns reply bytes. */
    feed(frame) {
        const { id, data } = parseCommand(frame);   // throws on a malformed frame
        this.commands.push(id);

        if (this.silent) {
            return new Uint8Array(0);
        }

        const reply = this.handle(id, data);

        if (this.dropReplies > 0) {
            this.dropReplies--;
            return new Uint8Array(0);                // the radio answered, the link ate it
        }

        return reply;
    }

    handle(id, data) {
        const reply = (rid, payload) => buildReply(rid, payload);

        if (id === 0x0514) {
            this.timestamp = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
            const version = new Uint8Array(36);
            version.set(Buffer.from("v6.0.0-test"), 0);
            return reply(0x0515, version);
        }

        if (id === 0x051b) {
            const offset = data[0] | (data[1] << 8);
            const size = data[2];
            if (data[3] !== 0) throw new Error("padding is not zero");
            const ts = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
            if (ts !== this.timestamp) throw new Error("read without a matching timestamp");
            const out = new Uint8Array(4 + size);
            out[0] = offset & 0xff;
            out[1] = (offset >> 8) & 0xff;
            out[2] = size;
            out[3] = 0;
            out.set(this.eeprom.slice(offset, offset + size), 4);
            return reply(0x051c, out);
        }

        if (id === 0x051d) {
            const offset = data[0] | (data[1] << 8);
            const size = data[2];
            const ts = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
            if (ts !== this.timestamp) throw new Error("write without a matching timestamp");
            if (data.length < 8 + size) throw new Error("short write payload");

            /* CMD_051D stores floor(size / 8) * 8 bytes, 8 at a time. */
            const stored = Math.floor(size / 8) * 8;
            for (let i = 0; i < stored; i += 8) {
                this.eeprom.set(data.slice(8 + i, 16 + i), offset + i);
                this.writes.push({ offset: offset + i, length: 8 });
            }
            if (this.eeprom[offset + size - 1] !== undefined && stored < size) {
                // the tail really is dropped; nothing to do, the caller must align
            }
            const out = new Uint8Array([offset & 0xff, (offset >> 8) & 0xff]);
            return reply(0x051e, out);
        }

        if (id === 0x0740) {
            const ts = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
            const status = (ts === this.timestamp) ? 0 : 1;
            const present = (this.font[T.font.versionOffset] === T.font.version) ? 1 : 0;
            const out = new Uint8Array(9);
            out[0] = present;
            out[1] = T.font.version;
            out[2] = status;
            out[3] = T.font.totalSize & 0xff;
            out[4] = (T.font.totalSize >>> 8) & 0xff;
            out[5] = (T.font.totalSize >>> 16) & 0xff;
            out[6] = (T.font.totalSize >>> 24) & 0xff;
            out[7] = T.font.charCount & 0xff;
            out[8] = (T.font.charCount >> 8) & 0xff;
            return reply(0x0741, out);
        }

        if (id === 0x0742) {
            const offset = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
            const length = data[4] | (data[5] << 8);
            const ts = data[6] | (data[7] << 8) | (data[8] << 16) | (data[9] << 24);
            let status = 0;

            if (ts !== this.timestamp) status = 1;
            else if (length !== data.length - 10 || length > T.font.chunkSize) status = 3;
            else if (offset + length > T.font.totalSize) status = 2;
            else {
                if (this.failFontWriteAt >= 0 && offset >= this.failFontWriteAt) {
                    status = 2;
                } else {
                    this.font.set(data.slice(10, 10 + length), offset);
                }
            }

            const out = new Uint8Array(7);
            out.set([offset & 0xff, (offset >>> 8) & 0xff, (offset >>> 16) & 0xff, (offset >>> 24) & 0xff], 0);
            out[4] = status === 0 ? length & 0xff : 0;
            out[5] = status === 0 ? (length >> 8) & 0xff : 0;
            out[6] = status;
            return reply(0x0743, out);
        }

        if (id === 0x0744) {
            const offset = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
            const length = data[4] | (data[5] << 8);
            const ts = data[6] | (data[7] << 8) | (data[8] << 16) | (data[9] << 24);
            let status = 0;
            let body = new Uint8Array(0);

            if (ts !== this.timestamp) status = 1;
            else if (length === 0 || length > 128) status = 3;
            else if (offset + length > T.font.totalSize) status = 2;
            else body = this.font.slice(offset, offset + length);

            const out = new Uint8Array(7 + body.length);
            out.set([offset & 0xff, (offset >>> 8) & 0xff, (offset >>> 16) & 0xff, (offset >>> 24) & 0xff], 0);
            out[4] = body.length & 0xff;
            out[5] = (body.length >> 8) & 0xff;
            out[6] = status;
            out.set(body, 7);
            return reply(0x0745, out);
        }

        if (id === 0x05dd) {
            this.reset = true;
            return new Uint8Array(0);
        }

        throw new Error("unexpected command 0x" + id.toString(16));
    }
}

/* Transport the Radio class talks to: bytes in, bytes out. */
class FakeTransport {
    constructor(radio) {
        this.radio = radio;
        this.queue = [];
        this.waiters = [];
    }

    async write(frame) {
        const reply = this.radio.feed(frame);
        if (reply.length === 0) return;
        this.queue.push(reply);
        const waiter = this.waiters.shift();
        if (waiter) waiter();
    }

    /* Mirrors the real transport: resolves null when nothing arrived in time. */
    async read(timeoutMs) {
        if (this.queue.length > 0) {
            return this.queue.shift();
        }

        return new Promise((resolve) => {
            let settled = false;
            const waiter = () => {
                if (!settled) {
                    settled = true;
                    resolve(this.queue.shift());
                }
            };

            this.waiters.push(waiter);

            if (timeoutMs > 0) {
                setTimeout(() => {
                    if (settled) return;
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    waiter();
                }, timeoutMs);
            }
        });
    }

    async close() {}
}

// --------------------------------------------------------------------- tests

console.log("== tables ==");

check(T.ctcssOptionsHz10.length === 50, "50 CTCSS tones parsed from dcs.c");
check(T.dcsOptions.length === 104, "104 DCS codes parsed from dcs.c");
check(T.powerLabels.length === 8 && T.powerLabels[7] === "HIGH", "power labels parsed from menu.c");
check(T.codeType.CODE_TYPE_CONTINUOUS_TONE === 1 && T.codeType.CODE_TYPE_DIGITAL === 2,
      "code type enum parsed from dcs.h");
check(T.offsetDirection.TX_OFFSET_FREQUENCY_DIRECTION_SUB === 2,
      "offset direction enum parsed from settings.h");
check(T.modulationLabels.MODULATION_USB === "USB", "modulation labels parsed from radio.c");
check(T.steps.length === 24 && T.steps[0].hz100 === 250, "step table parsed from frequencies.c");
check(T.namesBase === 0x004000 && T.attrsBase === 0x8000 && T.nameMaxBytes === 15,
      "flash layout parsed from settings.h / misc.c");
check(T.font.totalSize === 205367 && T.font.version === 2,
      "font layout parsed from cn_font.h");

{
    /* The font is one tenant of the external flash among several. Each of these
     * names an owner in the firmware (apps/app_overlay.h, app/audio.c,
     * app/rxtx_log.c) and is parsed from it by the generator, so a font address
     * that lands on top of somebody else fails here - which is exactly how a font
     * at 0x102000 once wiped the overlay-app slots. */
    const end = T.font.base + T.font.totalSize;

    check(T.font.base % 0x1000 === 0, "the font base is sector aligned",
          "0x" + T.font.base.toString(16));
    check(T.font.base >= T.regions.overlayApps.end,
          "the font starts above the overlay-app slots (" +
          "0x" + T.regions.overlayApps.base.toString(16) + "..0x" +
          T.regions.overlayApps.end.toString(16) + ")",
          "font at 0x" + T.font.base.toString(16));
    check(T.font.base >= T.regions.voiceDataBase,
          "the font starts above the voice resource",
          "font at 0x" + T.font.base.toString(16) + ", voice at 0x" +
          T.regions.voiceDataBase.toString(16));
    check(end <= T.regions.rxtxLogBase,
          "the font ends before the RX/TX log (0x" + T.regions.rxtxLogBase.toString(16) + ")",
          "font ends at 0x" + end.toString(16));
    check(end <= T.regions.flashSize, "the font fits in the 2 MiB flash");

    /* And it must not overlap any of the listed kernel regions either. */
    const conflicts = T.regions.kernel.filter((region) =>
        region.end !== null && T.font.base < region.end && end > region.base);

    check(conflicts.length === 0, "the font overlaps nothing listed in the flash map",
          conflicts.map((r) => r.name).join(", "));
}
check(T.cmd.readEeprom === 0x051b && T.cmd.writeEeprom === 0x051d && T.cmd.fontWrite === 0x0742,
      "command codes");

{
    const tmp = path.join(os.tmpdir(), "webflash_tables_check.js");

    /* stdio: inherit - a sandboxed runner may refuse a piped child process. */
    execFileSync(process.env.PYTHON || "python",
                 [path.join(WEBFLASH, "gen_tables.py"), tmp],
                 { cwd: REPO, stdio: "inherit" });

    const fresh = fs.readFileSync(tmp, "utf8").replace(/\r\n/g, "\n");
    const committed = fs.readFileSync(path.join(WEBFLASH, "js", "tables.js"), "utf8").replace(/\r\n/g, "\n");
    check(fresh === committed, "js/tables.js is in sync with the firmware sources",
          "run python tools/webflash/gen_tables.py");
    fs.rmSync(tmp, { force: true });
}

{
    /* Independent spot check: re-derive a few values from the C text itself, so a
     * generator bug cannot hide behind "the file matches the generator". */
    const dcsC = fs.readFileSync(path.join(REPO, "App", "dcs.c"), "utf8");
    const ctcssBlock = dcsC.slice(dcsC.indexOf("CTCSS_Options[50]"),
                                  dcsC.indexOf("};", dcsC.indexOf("CTCSS_Options[50]")));
    const ctcssValues = (ctcssBlock.match(/\b\d+\b/g) || []).slice(1).map(Number);

    check(ctcssValues.length === T.ctcssOptionsHz10.length &&
          ctcssValues.every((value, i) => value === T.ctcssOptionsHz10[i]),
          "CTCSS table matches dcs.c verbatim");

    const attrsC = fs.readFileSync(path.join(REPO, "App", "misc.c"), "utf8");
    const base = /FLASH_CHANNEL_ATTR_BASE\s+(0x[0-9a-fA-F]+)/.exec(attrsC);
    check(base && parseInt(base[1], 16) === T.attrsBase, "attribute block base matches misc.c");

    const fontH = fs.readFileSync(path.join(REPO, "App", "cn_font.h"), "utf8");
    const fontBase = /CN_FONT_FLASH_BASE\s+(0x[0-9a-fA-F]+)/.exec(fontH);
    check(fontBase && parseInt(fontBase[1], 16) === T.font.base, "font base matches cn_font.h");
}

console.log("\n== codec ==");

{
    /* Golden vector computed by hand from App/settings.c SETTINGS_SaveChannel:
     * rx 14550000 (0x00DE03F0), offset 0, rxCode 12, txCode 34,
     * rx CTCSS (1) / tx DCS (2), FM (0), offset direction + (1),
     * TX lock, power HIGH (7), narrow (1), reverse, DTMF decode on, PTT id 2 (END OF TX),
     * step STEP_10kHz (3):
     *   [10] = (2 << 4) | 1        = 0x21
     *   [11] = (0 << 4) | 1        = 0x01
     *   [12] = (1<<6)|(0<<5)|(7<<2)|(1<<1)|1 = 0x5F
     *   [13] = (2 << 1) | 1        = 0x05
     */
    const record = {
        rxFrequency: 14550000, txOffsetFrequency: 0,
        rxCode: 12, txCode: 34, rxCodeType: 1, txCodeType: 2,
        modulation: 0, txOffsetDirection: 1, txLock: 1, busyChannelLock: 0,
        outputPower: 7, channelBandwidth: 1, reverse: 1,
        dtmfDecodingEnable: 1, dtmfPttIdTxMode: 2, stepSetting: 3
    };
    const encoded = W.encodeRecord(record);
    const expected = bytes("f0 03 de 00 00 00 00 00 0c 22 21 01 5f 05 03 00");
    check(hex(encoded) === hex(expected), "record encoder matches the firmware layout", hex(encoded));
    check(hex(W.encodeRecord(W.decodeRecord(encoded))) === hex(expected), "record codec round trip");
}

{
    /* band 6, compander 1, exclude 1, scanlist 25 (ALL):
     * 6 | (1 << 3) | (1 << 7) | (25 << 8) = 0x198E -> 8e 19 */
    const encoded = W.encodeAttributes({ band: 6, compander: 1, exclude: 1, scanList: 25 });
    check(hex(encoded) === "8e 19", "attribute encoder matches the firmware bitfield", hex(encoded));

    const decoded = W.decodeAttributes(encoded);
    check(decoded.band === 6 && decoded.compander === 1 && decoded.exclude === 1 && decoded.scanList === 25,
          "attribute codec round trip");

    const erased = W.decodeAttributes(new Uint8Array([0xff, 0xff]).fill(0xff));
    check(erased.band === 7, "an erased attribute block reads as band 7 (= invalid channel)");
}

{
    check(W.decodeName(W.encodeName("CH-01")) === "CH-01", "ASCII name round trip");
    check(W.decodeName(W.encodeName("北京中继台")) === "北京中继台", "5 Hanzi name round trip");
    check(W.decodeName(W.encodeName("CH北京 1")) === "CH北京 1", "mixed name round trip");
    check(W.decodeName(W.encodeName("")) === "", "empty name");

    const name14 = "北京中继AB";
    check(W.decodeName(W.encodeName(name14 + "台")) === name14,
          "a 17-byte name is cut on a character boundary (last Hanzi dropped whole)",
          W.decodeName(W.encodeName(name14 + "台")));

    check(W.encodeName("北京中继台").length === 16 && W.encodeName("北京中继台")[15] === 0,
          "a name always fills exactly one 16-byte slot");

    check(W.decodeName(new Uint8Array(16).fill(0xff)) === "", "erased slot reads as empty");
    check(W.decodeName(new Uint8Array(16)) === "", "zeroed slot reads as empty");

    const torn = W.encodeName("北京中继AB");
    torn[14] = 0xe5;                                   // lone lead byte
    check(W.decodeName(torn) === name14, "a torn UTF-8 tail is dropped, not mis-decoded");

    const legacy = new Uint8Array(16);
    legacy.set(Array.from("LEGACY").map((c) => c.charCodeAt(0)), 0);
    check(W.decodeName(legacy) === "LEGACY", "legacy 10-character ASCII record still reads");
}

{
    check(W.formatFrequency(14550000) === "145.50000", "frequency formatting", W.formatFrequency(14550000));
    check(W.parseFrequency("145.5") === 14550000, "frequency parsing (MHz)", W.parseFrequency("145.5"));
    check(W.parseFrequency("433.50000") === 43350000, "frequency parsing (full precision)");
    check(W.parseFrequency("145500") === 14550000, "frequency parsing (kHz without a dot)",
          W.parseFrequency("145500"));
    check(W.parseFrequency("45500") === 4550000, "frequency parsing (short kHz)");
    check(W.parseFrequency("43350000") === null, "an ambiguous all-digit frequency is refused");
    check(W.parseFrequency("") === null && W.parseFrequency("abc") === null, "rejects empty input");
    check(W.formatCtcss(0) === "67.0 Hz", "CTCSS label", W.formatCtcss(0));
    check(W.formatDcs(0) === "D023N", "DCS label", W.formatDcs(0));
    check(W.bandForFrequency(14550000) === 2 && W.bandForFrequency(43350000) === 5,
          "band lookup for a new channel");
}

console.log("\n== protocol ==");

let radio = new FakeRadio();
let transport = new FakeTransport(radio);
let device = new W.Radio(transport, { timestamp: 0x12345678, timeout: 1500 });

check((await device.handshake()) === "v6.0.0-test", "0x0514 handshake returns the version");

{
    const pattern = Uint8Array.from({ length: 128 }, (_, i) => (i * 7) & 0xff);
    radio.eeprom.set(pattern, 0x1200);

    const read = await device.readEeprom(0x1200, 128);
    check(hex(read) === hex(pattern), "0x051B read returns exactly what was stored");

    let threw = false;
    try {
        await device.readEeprom(0, 129);
    } catch (error) {
        threw = true;
    }
    check(threw, "a read larger than 128 bytes is refused locally");

    radio.timestamp = 0xdeadbeef;                       // stale session
    threw = false;
    try {
        await device.readEeprom(0, 16);
    } catch (error) {
        threw = true;
    }
    check(threw, "a stale session is rejected by the radio");
    radio.timestamp = 0x12345678;
}

{
    const record = W.encodeRecord({
        rxFrequency: 43350000, txOffsetFrequency: 0, rxCode: 0, txCode: 0,
        rxCodeType: 0, txCodeType: 0, modulation: 0, txOffsetDirection: 0,
        txLock: 0, busyChannelLock: 0, outputPower: 7, channelBandwidth: 0,
        reverse: 0, dtmfDecodingEnable: 0, dtmfPttIdTxMode: 0, stepSetting: 5
    });

    await device.writeEeprom(16 * 5, record);
    check(hex(radio.eeprom.slice(16 * 5, 16 * 6)) === hex(record), "16-byte record write lands as sent");

    let threw = false;
    try {
        await device.writeEeprom(100, new Uint8Array(2));
    } catch (error) {
        threw = true;
    }
    check(threw, "an unaligned (2-byte) write is refused before it reaches the radio");
}

{
    /* The attribute block is 2 bytes; the radio stores whole 8-byte groups, so the
     * tool must preserve the three neighbouring channels. */
    radio.eeprom.fill(0xff, T.attrsBase, T.attrsBase + 8);
    await device.writeEeprom(T.attrsBase, bytes("01 00 02 00 03 00 04 00"));

    await W.writeAttributes(device, 2, W.encodeAttributes({ band: 6, compander: 0, exclude: 0, scanList: 25 }));
    const group = radio.eeprom.slice(T.attrsBase, T.attrsBase + 8);

    /* band 6 | (25 << 8) = 0x1906 -> 06 19 */
    check(hex(group) === hex(bytes("01 00 02 00 06 19 04 00")),
          "attribute write only touches its own two bytes", hex(group));
}

console.log("\n== whole-memory flow ==");

{
    radio = new FakeRadio();
    device = new W.Radio(new FakeTransport(radio), { timestamp: 0x0badf00d, timeout: 1500 });
    await device.handshake();

    const sample = W.encodeRecord({
        rxFrequency: 14550000, txOffsetFrequency: 600000, rxCode: 3, txCode: 3,
        rxCodeType: 1, txCodeType: 1, modulation: 0, txOffsetDirection: 1,
        txLock: 0, busyChannelLock: 0, outputPower: 6, channelBandwidth: 1,
        reverse: 0, dtmfDecodingEnable: 0, dtmfPttIdTxMode: 0, stepSetting: 4
    });
    radio.eeprom.set(sample, 16 * 7);
    radio.eeprom.set(bytes("8e 19"), T.attrsBase + 7 * 2);
    radio.eeprom.set(W.encodeName("中继北峰"), T.namesBase + 16 * 7);

    const memory = await W.readChannelMemory(device);
    const view = W.channelToView(memory, 7);

    check(view.used, "a programmed channel is reported as used");
    check(view.name === "中继北峰", "name read through the whole-memory path", view.name);
    check(view.record.rxFrequency === 14550000 && view.record.txCodeType === 1,
          "record read through the whole-memory path");
    check(view.attrs.scanList === 25 && view.attrs.band === 6, "attributes read through the whole-memory path");
    check(!W.channelToView(memory, 8).used, "an erased channel reads as unused");

    /* Edit two channels: one existing (name + record), one brand new. */
    const newRecord = W.encodeRecord({
        rxFrequency: 43950000, txOffsetFrequency: 0, rxCode: 0, txCode: 0,
        rxCodeType: 0, txCodeType: 0, modulation: 0, txOffsetDirection: 0,
        txLock: 0, busyChannelLock: 0, outputPower: 7, channelBandwidth: 0,
        reverse: 0, dtmfDecodingEnable: 0, dtmfPttIdTxMode: 0, stepSetting: 5
    });

    const changes = [
        { index: 7, name: W.encodeName("新名字"), record: sample },
        { index: 9, record: newRecord, name: W.encodeName("439.5"),
          attrs: W.encodeAttributes({ band: W.bandForFrequency(43950000), compander: 0,
                                      exclude: 0, scanList: 1 }) }
    ];

    await W.writeChannelChanges(device, changes);

    check(radio.eeprom[T.namesBase + 16 * 7 + 0] === 0xe6 &&
          W.decodeName(radio.eeprom.slice(T.namesBase + 16 * 7, T.namesBase + 16 * 7 + 16)) === "新名字",
          "edited name is stored");
    check(hex(radio.eeprom.slice(16 * 9, 16 * 10)) === hex(newRecord), "new channel record is stored");
    check(W.decodeAttributes(radio.eeprom.slice(T.attrsBase + 9 * 2, T.attrsBase + 9 * 2 + 2)).scanList === 1,
          "new channel attributes are stored");
    check(W.decodeAttributes(radio.eeprom.slice(T.attrsBase + 7 * 2, T.attrsBase + 7 * 2 + 2)).scanList === 25,
          "the other channel's attributes are untouched by the group write");

    /* clear */
    await W.writeChannelChanges(device, [{ index: 9, clear: true }]);
    check(hex(radio.eeprom.slice(16 * 9, 16 * 10)) === hex(new Uint8Array(16).fill(0xff)) &&
          W.decodeName(radio.eeprom.slice(T.namesBase + 16 * 9, T.namesBase + 16 * 9 + 16)) === "" &&
          W.decodeAttributes(radio.eeprom.slice(T.attrsBase + 9 * 2, T.attrsBase + 9 * 2 + 2)).band === 7,
          "clearing a channel leaves a factory-fresh slot");
}

console.log("\n== font ==");

let blob = null;

if (fs.existsSync(FONT_BLOB)) {
    blob = new Uint8Array(fs.readFileSync(FONT_BLOB));
    check(blob.length === T.font.totalSize, "font blob size matches cn_font.h", String(blob.length));

    const valid = W.validateFontBlob(blob);
    check(valid.ok, "font blob accepted by the pre-upload validation", valid.error);

    const short = blob.slice(0, blob.length - 1);
    check(!W.validateFontBlob(short).ok, "a truncated blob is refused");

    const wrongVersion = Uint8Array.from(blob);
    wrongVersion[T.font.versionOffset] = 3;
    check(!W.validateFontBlob(wrongVersion).ok, "a blob with the wrong version is refused");

    const wrongProbe = Uint8Array.from(blob);
    wrongProbe[1] = 0x12;                              /* 0x1100 -> 0x1200 */
    check(!W.validateFontBlob(wrongProbe).ok, "a blob with the wrong probe glyph is refused");

    const wrongIndex = Uint8Array.from(blob);
    wrongIndex[T.font.bitmapSize] = 0;
    wrongIndex[T.font.bitmapSize + 1] = 0;
    wrongIndex[T.font.bitmapSize + 2] = 0;
    wrongIndex[T.font.bitmapSize + 3] = 0;
    check(!W.validateFontBlob(wrongIndex).ok, "a blob whose index table is not CJK is refused");
} else {
    console.log("skip font blob checks (no file at " + FONT_BLOB + ")");
}

{
    radio = new FakeRadio();
    device = new W.Radio(new FakeTransport(radio), { timestamp: 0x5150, timeout: 1500 });
    await device.handshake();

    let info = await device.fontInfo();
    check(info.present === false, "a radio without a font reports it as absent");
    check(info.size === T.font.totalSize && info.characters === T.font.charCount,
          "font info carries the layout constants");

    if (blob) {
        let last = 0;
        await W.writeFontBlob(device, blob, {
            verify: true,
            onProgress: (done) => { last = done; }
        });

        check(hex(radio.font) === hex(blob), "the uploaded font matches the blob byte for byte");
        check(last === blob.length, "progress reaches 100%");

        info = await device.fontInfo();
        check(info.present === true, "the radio accepts the font afterwards");

        /* Interrupted upload: the version byte is the last byte of the blob, so a
         * stopped transfer must not look like a valid font. */
        const interrupted = new FakeRadio();
        const interruptedDevice = new W.Radio(new FakeTransport(interrupted),
                                             { timestamp: 0x5150, timeout: 1500 });
        await interruptedDevice.handshake();
        interrupted.failFontWriteAt = 40000;

        let threw = false;
        try {
            await W.writeFontBlob(interruptedDevice, blob, { verify: false });
        } catch (error) {
            threw = true;
        }

        check(threw, "an interrupted upload is reported as a failure");
        check(interrupted.font[T.font.versionOffset] === 0xff &&
              (await interruptedDevice.fontInfo()).present === false,
              "a half-written font is rejected at boot (version byte never written)");
    }
}

console.log("\n== resilience ==");

{
    /* A reply that the link eats must be retried, not fatal - and must not hang. */
    const sim = new FakeRadio();
    const dev = new W.Radio(new FakeTransport(sim), { timestamp: 0x1234, timeout: 400, retries: 3 });
    await dev.handshake();

    sim.dropReplies = 2;
    const info = await dev.fontInfo();
    check(info.size === T.font.totalSize, "a dropped reply is retried transparently");
    check(dev.lastAttempts === 3, "the third attempt succeeded", String(dev.lastAttempts));
}

{
    /* Total silence must fail within the retry budget instead of hanging: the
     * original bug was read() blocking forever on a lost reply. */
    const sim = new FakeRadio();
    const dev = new W.Radio(new FakeTransport(sim), { timestamp: 0x1234, timeout: 400, retries: 3 });
    await dev.handshake();
    sim.silent = true;

    const started = Date.now();
    let error = null;
    try {
        await dev.fontInfo();
    } catch (caught) {
        error = caught;
    }
    const elapsed = Date.now() - started;

    check(error !== null, "silence produces an error instead of hanging");
    check(error !== null && error.message.includes("0x740"), "the error names the command",
          error && error.message);
    check(elapsed >= 400 && elapsed < 2500, "it fails inside the retry budget (not instantly, not forever)",
          elapsed + " ms");
}

{
    /* An interrupted upload reports where it stopped, and can be resumed there. */
    const sim = new FakeRadio();
    const dev = new W.Radio(new FakeTransport(sim), { timestamp: 0x1234, timeout: 400, retries: 2 });
    await dev.handshake();

    const small = {
        blob: null
    };

    if (fs.existsSync(FONT_BLOB)) {
        const bytesIn = new Uint8Array(fs.readFileSync(FONT_BLOB));
        sim.failFontWriteAt = 30000;

        let error = null;
        try {
            await W.writeFontBlob(dev, bytesIn, { verify: false });
        } catch (caught) {
            error = caught;
        }

        check(error !== null, "an upload stalled by the radio reports an error");
        /* Chunks are 128 bytes, so the first refused one is at 30080 and the
         * confirmed prefix is exactly that many bytes. */
        check(error && error.writtenBytes === 30080,
              "the error reports the resume point", error && String(error.writtenBytes));

        sim.failFontWriteAt = -1;
        await W.writeFontBlob(dev, bytesIn, { startOffset: error.writtenBytes, verify: false });

        check(hex(sim.font.subarray(0, 30000)) === hex(bytesIn.subarray(0, 30000)),
              "the earlier part of the font survived");
        check(hex(sim.font) === hex(bytesIn), "resuming finishes the upload correctly");
    }
}

console.log("\n== channel order ==");

{
    /* --- the permutation itself ------------------------------------------ */

    const list = [0, 1, 2, 3];

    check(W.planReorder(list, 1, 1, false).length === 0, "reordering onto itself is a no-op");
    check(W.planReorder(list, 9, 1, false) === null, "a slot outside the list is refused");

    const down = W.planReorder(list, 0, 2, true);       // 0 goes after 2 -> [1, 2, 0, 3]
    check(JSON.stringify(down) === JSON.stringify([{ from: 1, to: 0 }, { from: 2, to: 1 }, { from: 0, to: 2 }]),
          "dropping below a row shifts the rows in between", JSON.stringify(down));
    check(W.landingSlot(down, 0) === 2, "the moved channel lands on the row it was dropped on");

    const up = W.planReorder(list, 3, 0, false);        // 3 goes before 0 -> [3, 0, 1, 2]
    check(JSON.stringify(up) === JSON.stringify([{ from: 3, to: 0 }, { from: 0, to: 1 }, { from: 1, to: 2 },
                                                 { from: 2, to: 3 }]),
          "dropping above a row shifts the other way", JSON.stringify(up));

    const swap = W.planReorder(list, 0, 1, true);       // one row down -> [1, 0, 2, 3]
    check(JSON.stringify(swap) === JSON.stringify([{ from: 1, to: 0 }, { from: 0, to: 1 }]),
          "the down arrow is a swap with the next row", JSON.stringify(swap));

    /* A filtered view must not mention anything it does not show. */
    const filtered = W.planReorder([0, 5, 900], 0, 900, true);
    check(filtered.every((move) => [0, 5, 900].includes(move.from) && [0, 5, 900].includes(move.to)),
          "reordering a filtered view only touches the shown slots", JSON.stringify(filtered));
    check(filtered.some((move) => move.to === 5 && move.from === 900),
          "hidden slots keep their slot numbers", JSON.stringify(filtered));

    let refused = false;
    try {
        W.planPermutation([0, 1, 2], [0, 1, 1]);
    } catch (error) {
        refused = true;
    }
    check(refused, "a duplicate in the target order is refused");

    /* --- the table, against a simulated radio ---------------------------- */

    radio = new FakeRadio();
    device = new W.Radio(new FakeTransport(radio), { timestamp: 0x0badf00d, timeout: 1500 });
    await device.handshake();

    const names = ["A", "B", "C", "D"];

    names.forEach((name, i) => {
        radio.eeprom.set(W.encodeRecord({
            rxFrequency: 14500000 + (i + 1) * 2500, txOffsetFrequency: 0, rxCode: 0, txCode: 0,
            rxCodeType: 0, txCodeType: 0, modulation: 0, txOffsetDirection: 0,
            txLock: 0, busyChannelLock: 0, outputPower: 6, channelBandwidth: 0,
            reverse: 0, dtmfDecodingEnable: 0, dtmfPttIdTxMode: 0, stepSetting: 4
        }), 16 * i);
        radio.eeprom.set(W.encodeAttributes({ band: 5, compander: 0, exclude: 0, scanList: 1 }),
                         T.attrsBase + i * 2);
        radio.eeprom.set(W.encodeName(name), T.namesBase + 16 * i);
    });

    const readBack = async () => {
        const table = new W.SlotTable(await W.readChannelMemory(device));

        return table;
    };

    const table = await readBack();

    check(table.usedCount() === 4, "the four programmed channels are read", String(table.usedCount()));
    check(table.content(0).name === "A" && table.content(3).name === "D", "they come back in slot order");
    check(table.changedCount() === 0, "a freshly read table needs no writes");

    /* Sorting with "show all" on: the empty slots must not cost a single write. */
    const allSlots = Array.from({ length: T.mrChannelsMax }, (_, i) => i);
    table.permute(allSlots, allSlots.slice().reverse());
    table.permute(allSlots, allSlots.slice().reverse());
    check(table.changedCount() === 0, "shuffling empty slots around writes nothing");

    /* Move A to the end of the four programmed channels (0 -> after 3). */
    const plan = table.reorder([0, 1, 2, 3], 0, 3, true);

    check(table.changedCount() === 4, "a move marks every displaced slot as changed",
          String(table.changedCount()));
    check(table.content(3).name === "A" && table.content(0).name === "B",
          "the moved channel is now last, the rest shifted up");

    await W.writeChannelChanges(device, table.changes());

    const after = await readBack();
    check([0, 1, 2, 3].map((i) => after.content(i).name).join("") === "BCDA",
          "the radio now holds the new order", [0, 1, 2, 3].map((i) => after.content(i).name).join(""));
    check(after.content(3).record.rxFrequency === 14502500,
          "the moved channel kept its frequency");
    check(after.changedCount() === 0, "writing the plan leaves nothing pending");
    check(W.decodeAttributes(radio.eeprom.slice(T.attrsBase + 3 * 2, T.attrsBase + 3 * 2 + 2)).scanList === 1,
          "the moved channel kept its attributes");

    /* Dragging a channel down onto an empty slot has to clear the slot it left,
     * otherwise the radio would show the channel twice. */
    const intoEmpty = await readBack();

    intoEmpty.clear(1);                       // slot 1 becomes a gap between A and C
    check(intoEmpty.changedCount() === 1, "clearing a slot is the only change so far");

    intoEmpty.reorder([0, 1, 2, 3], 0, 1, true);

    /* The radio already holds the order written above (B C D A), so the channel
     * being dragged down out of slot 0 is B. */
    const cleared = intoEmpty.changes().filter((change) => change.clear);
    check(cleared.length === 1 && cleared[0].index === 0, "the slot the channel left is cleared",
          JSON.stringify(cleared));
    check(intoEmpty.content(1).name === "B" && !intoEmpty.used(0),
          "the channel took the empty slot",
          intoEmpty.content(1).name + "/" + String(intoEmpty.used(0)));
    check(intoEmpty.changes().filter((change) => change.record && change.index !== 1).length === 0,
          "nothing outside the two rows is rewritten");

    /* A new channel is listed but never written while it has no frequency. */
    const empty = await readBack();
    const free = empty.firstFree();

    check(free === 4, "the first free slot is the one after the programmed channels", String(free));

    empty.add(free);
    check(empty.listable(free) && empty.changedCount() === 0,
          "a brand new channel is listed without being written");

    empty.set(free, Object.assign(W.newContent(), {
        pending: false,
        name: "新",
        record: Object.assign(W.newContent().record, { rxFrequency: 43950000 }),
        attrs: W.newContent().attrs
    }));
    check(empty.changedCount() === 1 && empty.changes()[0].record && empty.changes()[0].name &&
          empty.changes()[0].attrs, "once it has a frequency all three parts are written");

    /* Backup round trip: the slot numbers carry the order. */
    const json = table.json();
    const restored = new W.SlotTable(null);

    restored.load(json);
    check(restored.json().map((entry) => entry.name).join("") === "BCDA",
          "an exported list restores in the same order");
    check(restored.changedCount() === 4,
          "an import into an empty table wants exactly those four channels written",
          String(restored.changedCount()));

    /* Sorting by frequency, the way the page button does it. */
    const sorted = new W.SlotTable(null);
    [[0, 43950000, "high"], [1, 14550000, "low"], [2, 43350000, "mid"], [3, 0, "none"]].forEach(([i, hz]) => {
        sorted.set(i, Object.assign(W.newContent(), {
            pending: false,
            record: Object.assign(W.newContent().record, { rxFrequency: hz })
        }));
    });

    const ascending = [0, 1, 2].sort((a, b) =>
        sorted.content(a).record.rxFrequency - sorted.content(b).record.rxFrequency);

    sorted.permute([0, 1, 2], ascending);
    check([0, 1, 2].map((i) => sorted.content(i).record.rxFrequency).join(",") ===
          [14550000, 43350000, 43950000].join(","),
          "sorting by frequency reorders the slots");
}

console.log("\n== page ==");

{
    const html = fs.readFileSync(path.join(WEBFLASH, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

    check(scripts.length === 1, "index.html carries exactly one inline script", String(scripts.length));

    let compileError = "";
    try {
        new vm.Script(scripts[0], { filename: "index.html<script>" });
    } catch (error) {
        compileError = error.message;
    }
    check(compileError === "", "the page script compiles", compileError);

    /* Every element the script reaches for must exist in the markup. */
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...scripts[0].matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
    const missing = [...used].filter((id) => !ids.has(id));
    check(missing.length === 0, "every $(\"id\") the script uses exists in the page",
          missing.join(", "));

    check(html.includes('src="js/tables.js"') && html.includes('src="js/webflash.js"'),
          "the page loads both scripts as classic scripts (works from file://)");
    check(!/<script[^>]+type="module"/.test(html),
          "no module scripts (they would be blocked by CORS on file://)");
}

console.log("\n" + (failures === 0 ? "all webflash checks passed"
                                   : failures + " check(s) failed"));
process.exit(failures === 0 ? 0 : 1);
