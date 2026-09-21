/*
 * WebFlash - channel programming and font flashing for the UV-K1 / UV-K5 V3
 * F4HWN firmware, spoken over Web Serial.
 *
 * Plain classic script (no modules) so the page also works when opened straight
 * from disk. Everything it needs is exposed on globalThis.WebFlash, which is
 * also how the host test drives it under Node.
 *
 * Protocol (App/app/uart.c):
 *   host -> radio : AB CD | size | obf(payload + crc16) | DC BA
 *                   payload = id(2) + dataLen(2) + data, size = payload + 2
 *   radio -> host : AB CD | size | obf(payload) | pad(2) | DC BA   (SendReply)
 *                   payload = id(2) + dataLen(2) + data, size = payload
 * The two differ in whether the frame's size field covers the CRC, so the reply
 * reader accepts both layouts and checks the reply id.
 *
 * Channel memory (all addresses are inside the active config bank, uint16):
 *   ch * 16              16-byte channel record  (App/settings.c SETTINGS_SaveChannel)
 *   0x004000 + ch * 16   16-byte channel name    (15 bytes of UTF-8)
 *   0x008000 + ch * 2    2-byte channel attributes
 *
 * The 0x051D write handler only stores floor(size / 8) * 8 bytes
 * (App/app/uart.c CMD_051D), so every write here is a multiple of 8 bytes: the
 * 2-byte attribute block is read-modify-written as the 8-byte group that
 * contains it.
 */
globalThis.WebFlash = (function () {
    "use strict";

    var T = globalThis.WebFlashTables;

    if (!T) {
        throw new Error("tables.js 未加载（WebFlashTables 缺失）");
    }

    // ---------------------------------------------------------------- protocol

    var OBFUSCATION = [
        0x16, 0x6C, 0x14, 0xE6, 0x2E, 0x91, 0x0D, 0x40,
        0x21, 0x35, 0xD5, 0x40, 0x13, 0x03, 0xE9, 0x80
    ];

    /* CRC-16/CCITT-FALSE (poly 0x1021, init 0) - App/driver/crc.c */
    function crc16(bytes) {
        var crc = 0;

        for (var i = 0; i < bytes.length; i++) {
            crc ^= bytes[i] << 8;

            for (var bit = 0; bit < 8; bit++) {
                crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
            }
        }

        return crc;
    }

    function obfuscate(bytes) {
        var out = new Uint8Array(bytes.length);

        for (var i = 0; i < bytes.length; i++) {
            out[i] = bytes[i] ^ OBFUSCATION[i % 16];
        }

        return out;
    }

    function u16(value) {
        return [value & 0xFF, (value >> 8) & 0xFF];
    }

    function u32(value) {
        return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
    }

    function readU16(bytes, offset) {
        return bytes[offset] | (bytes[offset + 1] << 8);
    }

    function readU32(bytes, offset) {
        return (bytes[offset] | (bytes[offset + 1] << 8) |
                (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }

    /* One command frame, ready to be written to the port.
     *
     * The frame's size field is the payload length (id + dataLen + data), i.e. it
     * does NOT cover the two CRC bytes that follow the payload - that is what
     * UART_IsCommandAvailable() expects (it reads the CRC at Buffer[size]). */
    function buildCommand(id, data) {
        data = data || new Uint8Array(0);

        var payload = new Uint8Array(4 + data.length);
        payload[0] = id & 0xFF;
        payload[1] = (id >> 8) & 0xFF;
        payload[2] = data.length & 0xFF;
        payload[3] = (data.length >> 8) & 0xFF;
        payload.set(data, 4);

        var crc = crc16(payload);
        var body = new Uint8Array(payload.length + 2);
        body.set(payload, 0);
        body[payload.length] = crc & 0xFF;
        body[payload.length + 1] = (crc >> 8) & 0xFF;

        var frame = new Uint8Array(4 + body.length + 2);
        frame[0] = 0xAB;
        frame[1] = 0xCD;
        frame[2] = payload.length & 0xFF;
        frame[3] = (payload.length >> 8) & 0xFF;
        frame.set(obfuscate(body), 4);
        frame[frame.length - 2] = 0xDC;
        frame[frame.length - 1] = 0xBA;

        return frame;
    }

    /* Incremental reply reader: feed it whatever the port delivered, get back the
     * replies it could complete. */
    function ReplyReader(expectedId) {
        this.buffer = new Uint8Array(0);
        this.expectedId = expectedId;
    }

    ReplyReader.prototype.push = function (bytes) {
        var merged = new Uint8Array(this.buffer.length + bytes.length);
        merged.set(this.buffer, 0);
        merged.set(bytes, this.buffer.length);
        this.buffer = merged;

        // Keep the tail only: a broken stream should not grow without bound.
        if (this.buffer.length > 4096) {
            this.buffer = this.buffer.slice(this.buffer.length - 1024);
        }

        var replies = [];

        for (;;) {
            var parsed = this.take();

            if (!parsed) {
                break;
            }

            replies.push(parsed);
        }

        return replies;
    };

    ReplyReader.prototype.take = function () {
        var buf = this.buffer;
        var start = -1;

        for (var i = 0; i + 1 < buf.length; i++) {
            if (buf[i] === 0xAB && buf[i + 1] === 0xCD) {
                start = i;
                break;
            }
        }

        if (start < 0) {
            this.buffer = buf.slice(Math.max(0, buf.length - 1));
            return null;
        }

        if (start > 0) {
            this.buffer = buf = buf.slice(start);
        }

        if (buf.length < 8) {
            return null;
        }

        var size = readU16(buf, 2);

        if (size < 4 || size > 260) {
            this.buffer = buf.slice(1);
            return null;
        }

        /* Both directions use the same geometry: the size field is the payload
         * length, two more bytes follow it (a CRC on host->radio frames, padding
         * on radio->host ones - SendReply), and then the DC BA tail. */
        var total = 4 + size + 2 + 2;

        if (buf.length < total) {
            return null;
        }

        if (buf[4 + size + 2] !== 0xDC || buf[4 + size + 3] !== 0xBA) {
            this.buffer = buf.slice(1);
            return null;
        }

        var payload = obfuscate(buf.slice(4, 4 + size));

        this.buffer = buf.slice(total);

        var id = readU16(payload, 0);
        var dataLen = readU16(payload, 2);

        if (dataLen > size - 4) {
            return null;
        }

        if (this.expectedId !== undefined && id !== this.expectedId) {
            return null;
        }

        return { id: id, data: payload.slice(4, 4 + dataLen) };
    };

    // --------------------------------------------------------------- transport

    /* Byte-level view of a Web Serial port.
     *
     * A background pump drains the port into a queue, so read() can honour a
     * timeout. Reading with `await reader.read()` directly would hang forever on
     * a single dropped reply (Web Serial only resolves that promise when data
     * arrives), which freezes the whole transfer with no error at all. */
    async function serialTransport(port, baudRate) {
        var options = {};

        if (baudRate) {
            options.baudRate = baudRate;
        }

        await port.open(options);

        var reader = port.readable.getReader();
        var writer = port.writable.getWriter();
        var queue = [];
        var waiters = [];
        var finished = false;

        (async function pump() {
            try {
                for (;;) {
                    var result = await reader.read();

                    if (result.done) {
                        break;
                    }

                    if (result.value && result.value.length) {
                        var waiter = waiters.shift();

                        if (waiter) {
                            waiter(result.value);
                        } else {
                            queue.push(result.value);
                        }
                    }
                }
            } catch (error) {
                /* Port unplugged or cancelled: fall through and release waiters. */
            }

            finished = true;

            while (waiters.length) {
                waiters.shift()(null);
            }
        })();

        return {
            /* Resolves with the next chunk, or null when nothing arrived within
             * timeoutMs (the caller retries) or the port closed. */
            read: function (timeoutMs) {
                if (queue.length) {
                    return Promise.resolve(queue.shift());
                }

                if (finished) {
                    return Promise.resolve(null);
                }

                return new Promise(function (resolve) {
                    var settled = false;

                    var waiter = function (value) {
                        if (!settled) {
                            settled = true;
                            resolve(value);
                        }
                    };

                    waiters.push(waiter);

                    if (timeoutMs && timeoutMs > 0) {
                        setTimeout(function () {
                            if (settled) {
                                return;
                            }

                            var index = waiters.indexOf(waiter);

                            if (index >= 0) {
                                waiters.splice(index, 1);
                            }

                            waiter(null);
                        }, timeoutMs);
                    }
                });
            },
            write: function (bytes) {
                return writer.write(bytes);
            },
            close: async function () {
                try {
                    await reader.cancel();
                } catch (error) { /* already gone */ }

                try {
                    reader.releaseLock();
                } catch (error) { /* already released */ }

                try {
                    writer.releaseLock();
                } catch (error) { /* already released */ }

                try {
                    await port.close();
                } catch (error) { /* already closed */ }
            }
        };
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // -------------------------------------------------------------------- radio

    function Radio(transport, options) {
        this.transport = transport;
        this.timeout = (options && options.timeout) || 2000;
        this.retries = (options && options.retries) || 3;
        this.timestamp = (options && options.timestamp) || (Math.floor(Date.now() / 1000) & 0xFFFFFFFF);
        this.version = "";
        this.lastAttempts = 0;      // how many tries the last command needed
    }

    Radio.prototype.close = async function () {
        if (this.transport && this.transport.close) {
            await this.transport.close();
        }
    };

    /* Send one command and wait for its reply.
     *
     * A dropped reply is retried: Web Serial (and USB CDC in general) can lose
     * one now and then, and every command used here is idempotent - a repeated
     * write stores the same bytes, a repeated read reads the same bytes. Without
     * the retry (and without the transport timeout) a single lost reply would
     * freeze the whole transfer. */
    Radio.prototype.request = async function (id, data, replyId) {
        var attempts = this.retries;
        var lastError = null;

        for (var attempt = 1; attempt <= attempts; attempt++) {
            var reader = new ReplyReader(replyId);
            var deadline = Date.now() + this.timeout;

            try {
                await this.transport.write(buildCommand(id, data));
            } catch (error) {
                throw new Error("串口写入失败：" + (error.message || error) +
                                "（电台是否已断开？）");
            }

            while (Date.now() < deadline) {
                var chunk = await this.transport.read(Math.max(1, deadline - Date.now()));

                if (!chunk) {
                    break;                       // timeout or port closed
                }

                var replies = reader.push(chunk);

                if (replies.length > 0) {
                    this.lastAttempts = attempt;
                    return replies[0];
                }
            }

            lastError = new Error("命令 0x" + id.toString(16).toUpperCase() + " 第 " +
                                  attempt + " 次无应答");
            this.lastAttempts = attempt;

            if (attempt < attempts) {
                await delay(150 * attempt);
            }
        }

        throw new Error("电台无响应（命令 0x" + id.toString(16).toUpperCase() +
                        "，已重试 " + attempts + " 次）。请检查：电台是否开机并运行固件、" +
                        "是否锁屏、串口是否被其他写频软件占用；若仍失败可重新插拔或重启电台。" +
                        "（上次错误：" + lastError.message + "）");
    };

    /* 0x0514: latches the session timestamp every read/write is checked against. */
    Radio.prototype.handshake = async function () {
        var reply = await this.request(T.cmd.devInfo, new Uint8Array(u32(this.timestamp)),
                                       T.cmd.devInfoRsp);
        var bytes = reply.data;
        var text = "";

        for (var i = 0; i < 16 && bytes[i]; i++) {
            text += String.fromCharCode(bytes[i]);
        }

        this.version = text;

        return text;
    };

    Radio.prototype.readEeprom = async function (offset, size) {
        if (size > T.eepromReadMax) {
            throw new Error("单次读取最多 " + T.eepromReadMax + " 字节");
        }

        var data = new Uint8Array(8);
        data.set(u16(offset), 0);
        data[2] = size;
        data[3] = 0;
        data.set(u32(this.timestamp), 4);

        var reply = await this.request(T.cmd.readEeprom, data, T.cmd.readEepromRsp);

        if (reply.data.length < 4) {
            throw new Error("读回应答过短");
        }

        return reply.data.slice(4, 4 + reply.data[2]);
    };

    /* offset must be a multiple of 8: CMD_051D stores floor(size / 8) * 8 bytes. */
    Radio.prototype.writeEeprom = async function (offset, bytes) {
        if (bytes.length === 0 || (bytes.length % 8) !== 0) {
            throw new Error("写入长度必须是 8 的倍数（固件只保存整 8 字节）");
        }

        if (offset + bytes.length > T.eepromOffsetMax) {
            throw new Error("写入地址超出 16 位寻址范围");
        }

        var data = new Uint8Array(8 + bytes.length);
        data.set(u16(offset), 0);
        data[2] = bytes.length;
        data[3] = 0;                                   // bAllowPassword
        data.set(u32(this.timestamp), 4);
        data.set(bytes, 8);

        await this.request(T.cmd.writeEeprom, data, T.cmd.writeEepromRsp);
    };

    Radio.prototype.fontInfo = async function () {
        var reply = await this.request(T.cmd.fontInfo, new Uint8Array(u32(this.timestamp)),
                                       T.cmd.fontInfoRsp);
        var data = reply.data;

        if (data.length < 9) {
            throw new Error("字库信息应答过短（固件可能未启用 ENABLE_CHINESE）");
        }

        var status = data[2];

        if (status !== T.status.ok) {
            throw new Error("字库信息被拒绝：" + statusText(status));
        }

        return {
            present: data[0] !== 0,
            version: data[1],
            size: readU32(data, 3),
            characters: readU16(data, 7)
        };
    };

    Radio.prototype.fontWrite = async function (offset, bytes) {
        if (bytes.length === 0 || bytes.length > T.font.chunkSize) {
            throw new Error("字库单包最多 " + T.font.chunkSize + " 字节");
        }

        var data = new Uint8Array(10 + bytes.length);
        data.set(u32(offset), 0);
        data.set(u16(bytes.length), 4);
        data.set(u32(this.timestamp), 6);
        data.set(bytes, 10);

        var reply = await this.request(T.cmd.fontWrite, data, T.cmd.fontWriteRsp);

        if (reply.data.length < 7) {
            throw new Error("字库写入应答过短");
        }

        var written = readU16(reply.data, 4);
        var status = reply.data[6];

        if (status !== T.status.ok) {
            throw new Error("偏移 " + offset + " 写入被拒绝：" + statusText(status));
        }

        if (written !== bytes.length) {
            throw new Error("偏移 " + offset + " 只写入 " + written + "/" + bytes.length + " 字节");
        }
    };

    Radio.prototype.fontRead = async function (offset, size) {
        var data = new Uint8Array(10);
        data.set(u32(offset), 0);
        data.set(u16(size), 4);
        data.set(u32(this.timestamp), 6);

        var reply = await this.request(T.cmd.fontRead, data, T.cmd.fontReadRsp);

        if (reply.data.length < 7) {
            throw new Error("字库读取应答过短");
        }

        var status = reply.data[6];

        if (status !== T.status.ok) {
            throw new Error("偏移 " + offset + " 读取被拒绝：" + statusText(status));
        }

        return reply.data.slice(7, 7 + readU16(reply.data, 4));
    };

    /* 0x05DD: no reply, the radio restarts immediately. */
    Radio.prototype.reset = async function () {
        await this.transport.write(buildCommand(T.cmd.reset, new Uint8Array(0)));
    };

    function statusText(status) {
        switch (status) {
            case T.status.auth:  return "会话时间戳不匹配（请重新连接）";
            case T.status.range: return "地址/长度超出字库区域";
            case T.status.size:  return "请求长度非法";
            default:             return "状态 " + status;
        }
    }

    // -------------------------------------------------------------------- codec

    function utf8Encode(text) {
        if (globalThis.TextEncoder) {
            return new TextEncoder().encode(text);
        }

        // Minimal fallback (Node without TextEncoder, very old browsers).
        var bytes = [];

        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);

            if (code < 0x80) {
                bytes.push(code);
            } else if (code < 0x800) {
                bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
            } else {
                bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
            }
        }

        return new Uint8Array(bytes);
    }

    function utf8Decode(bytes) {
        var text = "";

        for (var i = 0; i < bytes.length;) {
            var byte = bytes[i];

            if (byte < 0x80) {
                text += String.fromCharCode(byte);
                i++;
            } else if (byte >= 0xC0 && byte < 0xE0 && i + 1 < bytes.length) {
                text += String.fromCharCode(((byte & 0x1F) << 6) | (bytes[i + 1] & 0x3F));
                i += 2;
            } else if (byte >= 0xE0 && byte < 0xF0 && i + 2 < bytes.length) {
                text += String.fromCharCode(((byte & 0x0F) << 12) |
                                            ((bytes[i + 1] & 0x3F) << 6) |
                                            (bytes[i + 2] & 0x3F));
                i += 3;
            } else {
                i++;
            }
        }

        return text;
    }

    /* Bytes of the character at `text[index]` (3 for a CJK sequence, else 1). */
    function utf8CharSize(bytes, index) {
        var byte = bytes[index];

        if (byte >= 0xE4 && byte <= 0xEF &&
            (bytes[index + 1] & 0xC0) === 0x80 && (bytes[index + 2] & 0xC0) === 0x80) {
            return 3;
        }

        return 1;
    }

    /* Mirror of SETTINGS_FetchChannelName: stop at NUL / 0xFF / anything that is
     * not valid UTF-8 or printable ASCII, then trim trailing spaces. */
    function decodeName(slotBytes) {
        var out = [];
        var i = 0;

        while (i < T.nameMaxBytes) {
            var byte = slotBytes[i];

            if (byte === 0x00 || byte === 0xFF) {
                break;
            }

            if (byte >= 0xE4 && byte <= 0xEF) {
                if (i + 2 >= T.nameMaxBytes ||
                    (slotBytes[i + 1] & 0xC0) !== 0x80 || (slotBytes[i + 2] & 0xC0) !== 0x80) {
                    break;
                }

                out.push(byte, slotBytes[i + 1], slotBytes[i + 2]);
                i += 3;
                continue;
            }

            if (byte < 32 || byte > 127) {
                break;
            }

            out.push(byte);
            i++;
        }

        while (out.length > 0 && out[out.length - 1] === 32) {
            out.pop();
        }

        return utf8Decode(Uint8Array.from(out));
    }

    /* Mirror of SETTINGS_SaveChannelName: 16 bytes, zero padded, never cutting a
     * UTF-8 sequence in half. */
    function encodeName(text) {
        var bytes = utf8Encode(text || "");
        var limit = Math.min(bytes.length, T.nameMaxBytes);

        while (limit > 0 && (bytes[limit] & 0xC0) === 0x80) {
            limit--;
        }

        var slot = new Uint8Array(T.namesSlotSize);
        slot.set(bytes.slice(0, limit), 0);

        return slot;
    }

    /* {band:3, compander:2, unused:2, exclude:1, scanlist:8} in a uint16. */
    function decodeAttributes(bytes) {
        var value = readU16(bytes, 0);

        return {
            raw: value,
            band: value & 0x07,
            compander: (value >> 3) & 0x03,
            exclude: (value >> 7) & 0x01,
            scanList: (value >> 8) & 0xFF
        };
    }

    function encodeAttributes(attrs) {
        var value = ((attrs.band & 0x07) |
                     ((attrs.compander & 0x03) << 3) |
                     ((attrs.exclude & 0x01) << 7) |
                     ((attrs.scanList & 0xFF) << 8)) >>> 0;
        var bytes = new Uint8Array(T.attrsSize);

        bytes[0] = value & 0xFF;
        bytes[1] = (value >> 8) & 0xFF;

        return bytes;
    }

    /* Mirror of the encoder in SETTINGS_SaveChannel (App/settings.c). */
    function decodeRecord(bytes) {
        return {
            rxFrequency: readU32(bytes, 0),
            txOffsetFrequency: readU32(bytes, 4),
            rxCode: bytes[8],
            txCode: bytes[9],
            rxCodeType: bytes[10] & 0x0F,
            txCodeType: (bytes[10] >> 4) & 0x0F,
            txOffsetDirection: bytes[11] & 0x0F,
            modulation: (bytes[11] >> 4) & 0x0F,
            reverse: bytes[12] & 0x01,
            channelBandwidth: (bytes[12] >> 1) & 0x01,
            outputPower: (bytes[12] >> 2) & 0x07,
            busyChannelLock: (bytes[12] >> 5) & 0x01,
            txLock: (bytes[12] >> 6) & 0x01,
            dtmfDecodingEnable: bytes[13] & 0x01,
            dtmfPttIdTxMode: (bytes[13] >> 1) & 0x07,
            stepSetting: bytes[14],
            scramblingOrReserved: bytes[15]
        };
    }

    function encodeRecord(record) {
        var bytes = new Uint8Array(T.recordSize);

        bytes.set(u32(record.rxFrequency >>> 0), 0);
        bytes.set(u32((record.txOffsetFrequency || 0) >>> 0), 4);
        bytes[8] = record.rxCode & 0xFF;
        bytes[9] = record.txCode & 0xFF;
        bytes[10] = ((record.txCodeType & 0x0F) << 4) | (record.rxCodeType & 0x0F);
        bytes[11] = ((record.modulation & 0x0F) << 4) | (record.txOffsetDirection & 0x0F);
        bytes[12] = ((record.txLock & 0x01) << 6) |
                    ((record.busyChannelLock & 0x01) << 5) |
                    ((record.outputPower & 0x07) << 2) |
                    ((record.channelBandwidth & 0x01) << 1) |
                    (record.reverse & 0x01);
        bytes[13] = ((record.dtmfPttIdTxMode & 0x07) << 1) | (record.dtmfDecodingEnable & 0x01);
        bytes[14] = record.stepSetting & 0xFF;
        bytes[15] = 0;                      // F4HWN builds leave this byte zero

        return bytes;
    }

    function isChannelUsed(record) {
        return record.rxFrequency !== 0 && record.rxFrequency !== 0xFFFFFFFF;
    }

    /* FREQUENCY_GetBand(): the highest band whose lower bound the frequency
     * reaches (frequencyBandTable[] parsed from frequencies.c). Only used to give
     * a brand new channel a sane calibration band; existing channels keep
     * whatever the radio already stored. */
    function bandForFrequency(rxFrequency) {
        var lower = T.bandLowerHz10 || [];

        for (var band = lower.length - 1; band >= 0; band--) {
            if (lower[band] !== null && lower[band] !== undefined && rxFrequency >= lower[band]) {
                return band;
            }
        }

        return 0;
    }

    /* Stored frequencies are in 10 Hz units: 43350000 -> 433.50000 MHz. */
    function formatFrequency(value) {
        if (!isChannelUsed({ rxFrequency: value })) {
            return "";
        }

        var text = String(value);

        while (text.length < 8) {
            text = "0" + text;
        }

        return text.slice(0, text.length - 5) + "." + text.slice(text.length - 5);
    }

    /* Accepts "145.5" / "145.50000" (MHz) or "145500" (kHz, six digits or fewer).
     * Returns the stored unit (10 Hz), or null. */
    function parseFrequency(text) {
        var cleaned = String(text || "").trim().replace(/[^0-9.]/g, "");
        var value;

        if (cleaned === "" || cleaned === ".") {
            return null;
        }

        if (cleaned.indexOf(".") >= 0) {
            value = Math.round(parseFloat(cleaned) * 100000);          // MHz
        } else {
            var digits = cleaned.replace(/^0+/, "");

            if (digits.length > 6) {
                return null;                                          // ambiguous
            }

            value = parseInt(digits, 10) * 100;                        // kHz
        }

        if (!isFinite(value) || value <= 0 || value > 0xFFFFFFFF) {
            return null;
        }

        return value >>> 0;
    }

    function formatCtcss(code) {
        var hz10 = T.ctcssOptionsHz10[code];

        return (hz10 === undefined) ? ("#" + code) : (hz10 / 10).toFixed(1) + " Hz";
    }

    function formatDcs(code) {
        var value = T.dcsOptions[code];

        return (value === undefined) ? ("#" + code) : ("D" + value.toString(8).padStart(3, "0") + "N");
    }

    function formatCode(codeType, code) {
        switch (codeType) {
            case T.codeType.CODE_TYPE_CONTINUOUS_TONE: return formatCtcss(code);
            case T.codeType.CODE_TYPE_DIGITAL:         return formatDcs(code);
            case T.codeType.CODE_TYPE_REVERSE_DIGITAL: return formatDcs(code) + "I";
            default:                                   return "OFF";
        }
    }

    function formatStep(index) {
        var step = T.steps[index];

        if (!step) {
            return "#" + index;
        }

        var khz = step.hz100 / 100;

        return (khz < 10 ? khz.toFixed(2) : khz.toFixed(khz % 1 ? 2 : 0).replace(/\.?0+$/, "")) + " kHz";
    }

    // ------------------------------------------------------------- whole memory

    /* Read the channel record, name and attribute regions. */
    async function readChannelMemory(radio, options) {
        var count = T.mrChannelsMax;
        var chunk = T.eepromReadMax;
        var records = new Uint8Array(count * T.recordSize);
        var names = new Uint8Array(count * T.namesSlotSize);
        var attrs = new Uint8Array(count * T.attrsSize);
        var onProgress = (options && options.onProgress) || null;
        var totalSteps = Math.ceil((count * T.recordSize) / chunk) +
                         Math.ceil((count * T.namesSlotSize) / chunk) +
                         Math.ceil((count * T.attrsSize) / 8);
        var step = 0;

        function report(label) {
            if (onProgress) {
                onProgress(++step, totalSteps, label);
            }
        }

        for (var offset = 0; offset < records.length; offset += chunk) {
            records.set(await radio.readEeprom(offset, Math.min(chunk, records.length - offset)), offset);
            report("信道数据");
        }

        for (var offset2 = 0; offset2 < names.length; offset2 += chunk) {
            names.set(await radio.readEeprom(T.namesBase + offset2,
                                             Math.min(chunk, names.length - offset2)), offset2);
            report("信道名");
        }

        for (var offset3 = 0; offset3 < attrs.length; offset3 += chunk) {
            attrs.set(await radio.readEeprom(T.attrsBase + offset3,
                                             Math.min(chunk, attrs.length - offset3)), offset3);
            report("信道属性");
        }

        return { records: records, names: names, attrs: attrs };
    }

    /* One entry per channel, ready for the UI. */
    function channelToView(memory, index) {
        var record = decodeRecord(memory.records.subarray(index * T.recordSize,
                                                          (index + 1) * T.recordSize));
        var attrs = decodeAttributes(memory.attrs.subarray(index * T.attrsSize,
                                                           (index + 1) * T.attrsSize));
        var name = decodeName(memory.names.subarray(index * T.namesSlotSize,
                                                    (index + 1) * T.namesSlotSize));

        return {
            index: index,
            used: isChannelUsed(record),
            name: name,
            record: record,
            attrs: attrs
        };
    }

    /* Write back only what changed. Each change is {index, record?, name?, attrs?};
     * an "empty" change clears the slot the way a factory reset leaves it. */
    async function writeChannelChanges(radio, changes, options) {
        var onProgress = (options && options.onProgress) || null;
        var done = 0;

        for (var i = 0; i < changes.length; i++) {
            var change = changes[i];
            var index = change.index;

            if (change.clear) {
                await radio.writeEeprom(index * T.recordSize, new Uint8Array(T.recordSize).fill(0xFF));
                await radio.writeEeprom(T.namesBase + index * T.namesSlotSize,
                                        new Uint8Array(T.namesSlotSize));
                await writeAttributes(radio, index, null);
            } else {
                if (change.record) {
                    await radio.writeEeprom(index * T.recordSize, change.record);
                }

                if (change.name) {
                    await radio.writeEeprom(T.namesBase + index * T.namesSlotSize, change.name);
                }

                if (change.attrs) {
                    await writeAttributes(radio, index, change.attrs);
                }
            }

            done++;

            if (onProgress) {
                onProgress(done, changes.length, index);
            }
        }
    }

    /* The firmware stores two attribute bytes with one 8-byte write, so patch the
     * containing 8-byte group (four channels) instead of clobbering neighbours. */
    async function writeAttributes(radio, index, attrsBytes) {
        var groupOffset = T.attrsBase + ((index >> 2) << 3);
        var group = await radio.readEeprom(groupOffset, 8);
        var within = (index & 3) * T.attrsSize;

        if (attrsBytes === null) {
            group[within] = 0xFF;
            group[within + 1] = 0xFF;
        } else {
            group[within] = attrsBytes[0];
            group[within + 1] = attrsBytes[1];
        }

        await radio.writeEeprom(groupOffset, group);
    }

    // --------------------------------------------------------- channel table

    /* Reordering. `slots` is the order the user is looking at - normally the
     * programmed channels in slot order, but any subset works. The channel at
     * `from` is taken out and put back next to `to`, before it or after it when
     * `after` is set, and the slots in between shift by one.
     *
     * The result is a list of {from, to} pairs meaning "the content of `from`
     * goes to `to`". Slots outside `slots` are never mentioned, so reordering a
     * filtered view only rearranges what it shows and leaves every hidden channel
     * where it is. Returns null when either slot is not in the list. */
    function planReorder(slots, from, to, after) {
        var at = slots.indexOf(from);
        var target = slots.indexOf(to);

        if (at < 0 || target < 0) {
            return null;
        }

        if (from === to) {
            return [];
        }

        var rest = slots.slice(0, at).concat(slots.slice(at + 1));
        var insert = rest.indexOf(to) + (after ? 1 : 0);

        return planPermutation(slots, rest.slice(0, insert).concat([from], rest.slice(insert)));
    }

    /* The same, from an order the caller worked out itself (sorting, for
     * example): `order` has to be a permutation of `slots`. */
    function planPermutation(slots, order) {
        var seen = {};
        var plan = [];

        if (order.length !== slots.length) {
            throw new Error("新顺序的长度与信道数量不一致");
        }

        for (var i = 0; i < order.length; i++) {
            if (slots.indexOf(order[i]) < 0 || seen[order[i]]) {
                throw new Error("新顺序里有重复或不属于当前列表的信道");
            }

            seen[order[i]] = true;
        }

        for (var j = 0; j < slots.length; j++) {
            if (slots[j] !== order[j]) {
                plan.push({ from: order[j], to: slots[j] });
            }
        }

        return plan;
    }

    /* Which slot the content that started at `from` ends up in. */
    function landingSlot(plan, from) {
        for (var i = 0; i < (plan ? plan.length : 0); i++) {
            if (plan[i].from === from) {
                return plan[i].to;
            }
        }

        return from;
    }

    // ---------------------------------------------------------- slot contents

    function copyObject(source) {
        var out = {};
        var key;

        for (key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                out[key] = source[key];
            }
        }

        return out;
    }

    function cloneContent(content) {
        return {
            pending: !!content.pending,
            name: content.name || "",
            record: copyObject(content.record),
            attrs: copyObject(content.attrs)
        };
    }

    /* A slot with nothing in it. band 7 is what the firmware itself stores for a
     * deleted channel, so an empty slot reads as "no channel" everywhere. */
    function emptyContent() {
        return {
            pending: false,
            name: "",
            record: {
                rxFrequency: 0, txOffsetFrequency: 0, rxCode: 0, txCode: 0,
                rxCodeType: 0, txCodeType: 0, txOffsetDirection: 0, modulation: 0,
                outputPower: 7, channelBandwidth: 0, txLock: 0, busyChannelLock: 0,
                reverse: 0, dtmfDecodingEnable: 0, dtmfPttIdTxMode: 0, stepSetting: 5,
                scramblingOrReserved: 0
            },
            attrs: { raw: 0, band: 7, compander: 0, exclude: 0, scanList: 0 }
        };
    }

    /* What the page starts a brand new channel from: HIGH power and a 12.5 kHz
     * step, the same defaults the radio puts on a fresh channel. */
    function newContent() {
        var content = emptyContent();

        content.pending = true;
        content.attrs.band = 5;

        return content;
    }

    /* The fields the record encoder actually writes. Byte 15 (scrambling) is
     * always zeroed by encodeRecord(), so it is deliberately not compared: a
     * channel is "changed" only when something that would be stored differs. */
    var recordFields = [
        "rxFrequency", "txOffsetFrequency", "rxCode", "txCode", "rxCodeType", "txCodeType",
        "txOffsetDirection", "modulation", "outputPower", "channelBandwidth", "txLock",
        "busyChannelLock", "reverse", "dtmfDecodingEnable", "dtmfPttIdTxMode", "stepSetting"
    ];

    function sameRecord(a, b) {
        for (var i = 0; i < recordFields.length; i++) {
            if ((a[recordFields[i]] || 0) !== (b[recordFields[i]] || 0)) {
                return false;
            }
        }

        return true;
    }

    function sameBytes(a, b) {
        if (a.length !== b.length) {
            return false;
        }

        for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }

        return true;
    }

    function sameAttrs(a, b) {
        return sameBytes(encodeAttributes(a), encodeAttributes(b));
    }

    /* The whole channel table as the page edits it: a desired state per slot
     * ("slots") next to the untouched snapshot the radio gave us ("original").
     *
     * Everything the page shows and everything that is written is derived from
     * those two, which is what makes reordering trivial: a move only swaps
     * content between slots, and changes() then reports exactly the slots whose
     * stored bytes would differ. Empty slots are equal to each other no matter
     * what the radio left in them, so shuffling them around costs no writes. */
    function SlotTable(memory) {
        this.original = [];
        this.slots = [];

        for (var i = 0; i < T.mrChannelsMax; i++) {
            var view = (memory ? channelToView(memory, i) : null);

            this.original.push(view
                ? { pending: false, name: view.name, record: view.record, attrs: view.attrs }
                : emptyContent());
        }

        for (var j = 0; j < this.original.length; j++) {
            this.slots.push(cloneContent(this.original[j]));
        }
    }

    SlotTable.prototype = {
        count: function () { return this.slots.length; },

        content: function (index) { return this.slots[index]; },
        originalContent: function (index) { return this.original[index]; },

        set: function (index, content) { this.slots[index] = cloneContent(content); },
        clear: function (index) { this.slots[index] = emptyContent(); },

        /* A slot the radio knows nothing about yet: listed while the user fills it
         * in, never written while it has no frequency. */
        add: function (index) {
            this.slots[index] = newContent();

            return this.slots[index];
        },

        used: function (index) { return isChannelUsed(this.slots[index].record); },
        originalUsed: function (index) { return isChannelUsed(this.original[index].record); },
        pending: function (index) { return !!this.slots[index].pending; },

        listable: function (index) { return this.used(index) || this.pending(index); },

        firstFree: function () {
            for (var i = 0; i < this.slots.length; i++) {
                if (!this.used(i)) {
                    return i;
                }
            }

            return -1;
        },

        usedCount: function () {
            var n = 0;

            for (var i = 0; i < this.slots.length; i++) {
                if (this.used(i)) {
                    n++;
                }
            }

            return n;
        },

        /* True when this slot would be written. Cheap on purpose: the page calls
         * it for every row on every keystroke. */
        changed: function (index) {
            var want = this.slots[index];
            var have = this.original[index];
            var wantUsed = isChannelUsed(want.record);

            if (!wantUsed) {
                return isChannelUsed(have.record);
            }

            if (!isChannelUsed(have.record)) {
                return true;
            }

            return want.name !== have.name ||
                   !sameRecord(want.record, have.record) ||
                   !sameAttrs(want.attrs, have.attrs);
        },

        changedCount: function () {
            var n = 0;

            for (var i = 0; i < this.slots.length; i++) {
                if (this.changed(i)) {
                    n++;
                }
            }

            return n;
        },

        /* What writeChannelChanges() needs for one slot, or null when the radio
         * already holds it. */
        changeFor: function (index) {
            var want = this.slots[index];
            var have = this.original[index];
            var wantUsed = isChannelUsed(want.record);
            var haveUsed = isChannelUsed(have.record);
            var change = { index: index };

            if (!wantUsed) {
                return haveUsed ? { index: index, clear: true } : null;
            }

            if (!haveUsed || !sameBytes(encodeRecord(want.record), encodeRecord(have.record))) {
                change.record = encodeRecord(want.record);
            }

            if (!haveUsed || want.name !== have.name) {
                change.name = encodeName(want.name);
            }

            if (!haveUsed || !sameAttrs(want.attrs, have.attrs)) {
                change.attrs = encodeAttributes(want.attrs);
            }

            return (change.record || change.name || change.attrs) ? change : null;
        },

        changes: function () {
            var out = [];

            for (var i = 0; i < this.slots.length; i++) {
                var change = this.changeFor(i);

                if (change) {
                    out.push(change);
                }
            }

            return out;
        },

        /* Move content between slots. Two passes, so that a chain of moves (A->B,
         * B->C) can never copy content that has already been overwritten. */
        applyPlan: function (plan) {
            var moves = [];
            var i;

            for (i = 0; i < (plan ? plan.length : 0); i++) {
                moves.push({ to: plan[i].to, content: cloneContent(this.slots[plan[i].from]) });
            }

            for (i = 0; i < moves.length; i++) {
                this.slots[moves[i].to] = moves[i].content;
            }

            return plan;
        },

        reorder: function (slotList, from, to, after) {
            return this.applyPlan(planReorder(slotList, from, to, after));
        },

        permute: function (slotList, order) {
            return this.applyPlan(planPermutation(slotList, order));
        },

        /* Backup / restore. Only channels that are actually programmed are
         * exported; entries carry their slot number, so a reordered list comes
         * back in the order it was exported. */
        json: function () {
            var out = [];

            for (var i = 0; i < this.slots.length; i++) {
                var content = this.slots[i];

                if (!isChannelUsed(content.record)) {
                    continue;
                }

                var record = content.record;
                var attrs = content.attrs;

                out.push({
                    index: i,
                    name: content.name,
                    rxFrequency: record.rxFrequency,
                    txOffsetFrequency: record.txOffsetFrequency,
                    txOffsetDirection: record.txOffsetDirection,
                    rxCode: record.rxCode, txCode: record.txCode,
                    rxCodeType: record.rxCodeType, txCodeType: record.txCodeType,
                    modulation: record.modulation,
                    outputPower: record.outputPower,
                    channelBandwidth: record.channelBandwidth,
                    txLock: record.txLock,
                    busyChannelLock: record.busyChannelLock,
                    reverse: record.reverse,
                    dtmfDecodingEnable: record.dtmfDecodingEnable,
                    dtmfPttIdTxMode: record.dtmfPttIdTxMode,
                    stepSetting: record.stepSetting,
                    band: attrs.band,
                    compander: attrs.compander,
                    exclude: attrs.exclude,
                    scanList: attrs.scanList
                });
            }

            return out;
        },

        load: function (entries) {
            var loaded = 0;

            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var index = Number(entry.index);

                if (!(index >= 0 && index < this.slots.length)) {
                    continue;
                }

                var record = {
                    rxFrequency: entry.rxFrequency, txOffsetFrequency: entry.txOffsetFrequency,
                    rxCode: entry.rxCode, txCode: entry.txCode,
                    rxCodeType: entry.rxCodeType, txCodeType: entry.txCodeType,
                    txOffsetDirection: entry.txOffsetDirection, modulation: entry.modulation,
                    outputPower: entry.outputPower, channelBandwidth: entry.channelBandwidth,
                    txLock: entry.txLock, busyChannelLock: entry.busyChannelLock,
                    reverse: entry.reverse, dtmfDecodingEnable: entry.dtmfDecodingEnable,
                    dtmfPttIdTxMode: entry.dtmfPttIdTxMode, stepSetting: entry.stepSetting,
                    scramblingOrReserved: 0
                };

                this.slots[index] = {
                    pending: !isChannelUsed(record),
                    name: entry.name || "",
                    record: record,
                    attrs: {
                        raw: 0,
                        band: Number(entry.band) || 0,
                        compander: Number(entry.compander) || 0,
                        exclude: Number(entry.exclude) || 0,
                        scanList: Number(entry.scanList) || 0
                    }
                };

                loaded++;
            }

            return loaded;
        }
    };

    // --------------------------------------------------------------------- font

    /* Same checks upload_cn_font.py and CN_FONT_Init() make: a mismatched blob
     * must be refused before it reaches the radio. */
    function validateFontBlob(bytes) {
        if (bytes.length !== T.font.totalSize) {
            return { ok: false, error: "字库文件 " + bytes.length + " 字节，应为 " + T.font.totalSize + " 字节" };
        }

        if (bytes[T.font.versionOffset] !== T.font.version) {
            return { ok: false, error: "版本字节为 " + bytes[T.font.versionOffset] + "，应为 " + T.font.version };
        }

        if (bytes[0] !== 0x00 || bytes[1] !== 0x11 || bytes[2] !== 0x00 || bytes[3] !== 0x21) {
            return { ok: false, error: "首字形探测值不匹配（期待 0x1100,0x2100）" };
        }

        var entry = readU32(bytes, T.font.bitmapSize);
        var first = entry >>> 16;

        if (first < 0x4E00 || first > 0x9FFF) {
            return { ok: false, error: "索引表首项 U+" + first.toString(16).toUpperCase() + "，不是汉字" };
        }

        return { ok: true, error: "" };
    }

    /* Front-to-back, so an interrupted upload leaves the version byte (the last
     * byte of the blob) unset and the radio rejects the half-written font. That
     * also makes an upload resumable: pass startOffset to carry on where the
     * previous attempt stopped (a chunk is only counted as done once the radio
     * acknowledged it, and re-writing a chunk stores the same bytes). */
    async function writeFontBlob(radio, bytes, options) {
        var onProgress = (options && options.onProgress) || null;
        var chunk = T.font.chunkSize;
        var started = Date.now();
        var offset = (options && options.startOffset) || 0;

        try {
            while (offset < bytes.length) {
                var slice = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));

                await radio.fontWrite(offset, slice);
                offset += slice.length;

                if (onProgress) {
                    onProgress(offset, bytes.length, Date.now() - started, false);
                }
            }

            if (options && options.verify) {
                for (var checkAt = 0; checkAt < bytes.length; checkAt += chunk) {
                    var expected = bytes.subarray(checkAt, Math.min(checkAt + chunk, bytes.length));
                    var actual = await radio.fontRead(checkAt, expected.length);

                    for (var i = 0; i < expected.length; i++) {
                        if (expected[i] !== actual[i]) {
                            throw new Error("回读校验失败，偏移 " + (checkAt + i));
                        }
                    }

                    if (onProgress) {
                        onProgress(checkAt + expected.length, bytes.length,
                                   Date.now() - started, true);
                    }
                }
            }
        } catch (error) {
            /* Tell the caller exactly where to resume from. */
            error.writtenBytes = offset;
            throw error;
        }
    }

    return {
        tables: T,
        crc16: crc16,
        obfuscate: obfuscate,
        buildCommand: buildCommand,
        ReplyReader: ReplyReader,
        serialTransport: serialTransport,
        Radio: Radio,
        utf8Encode: utf8Encode,
        utf8Decode: utf8Decode,
        utf8CharSize: utf8CharSize,
        decodeName: decodeName,
        encodeName: encodeName,
        decodeAttributes: decodeAttributes,
        encodeAttributes: encodeAttributes,
        decodeRecord: decodeRecord,
        encodeRecord: encodeRecord,
        isChannelUsed: isChannelUsed,
        bandForFrequency: bandForFrequency,
        bandLabels: T.bandLabels,
        formatFrequency: formatFrequency,
        parseFrequency: parseFrequency,
        formatCtcss: formatCtcss,
        formatDcs: formatDcs,
        formatCode: formatCode,
        formatStep: formatStep,
        readChannelMemory: readChannelMemory,
        channelToView: channelToView,
        writeChannelChanges: writeChannelChanges,
        writeAttributes: writeAttributes,
        planReorder: planReorder,
        planPermutation: planPermutation,
        landingSlot: landingSlot,
        emptyContent: emptyContent,
        newContent: newContent,
        SlotTable: SlotTable,
        validateFontBlob: validateFontBlob,
        writeFontBlob: writeFontBlob
    };
})();
