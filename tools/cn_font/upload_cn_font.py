#!/usr/bin/env python3
"""Upload the Chinese (UTF-8) channel-name font to a UV-K1 / UV-K5 V3.

The font is a 12x12 bitmap font plus a pinyin table: about 200 KiB, far too big
for the radio's 118 KiB internal application flash, so it is kept in the
external SPI flash and pushed there from the host. It has to be uploaded once
per radio (or after a full external-flash wipe); it survives firmware updates,
because it sits above the config-bank boundary and every multiboot slot shares
it.

The firmware has to be built with ENABLE_CHINESE, otherwise it will answer
nothing (the 0x0740/0x0742/0x0744 commands only exist in that build).

Usage
-----
    python upload_cn_font.py --port COM7
    python upload_cn_font.py --port /dev/ttyUSB0 --file my_cn_font.bin
    python upload_cn_font.py --port COM7 --info
    python upload_cn_font.py --port COM7 --no-verify

Requires pyserial:  python -m pip install pyserial
"""

import argparse
import os
import struct
import sys
import time

# ---------------------------------------------------------------------------
# Font blob layout (must match App/cn_font.h)
# ---------------------------------------------------------------------------

CN_FONT_CHAR_COUNT = 6766
CN_FONT_BITMAP_SIZE = 162384
CN_FONT_INDEX_SIZE = 27064
CN_FONT_PY_OFFSET = 189448
CN_FONT_PY_TOTAL_SIZE = 15918
CN_FONT_VERSION = 2
CN_FONT_VERSION_OFFSET = 205366
CN_FONT_TOTAL_SIZE = CN_FONT_VERSION_OFFSET + 1
# Where the blob lives in the external SPI flash. Must match cn_font.h: last free
# stretch of the 2 MiB part, above the overlay-app region (0x102000..0x122000) and
# the voice resource, below the RX/TX log at 0x1E0000.
CN_FONT_FLASH_BASE = 0x001AD000
# Largest payload accepted by one 0x0742 write (App/cn_font.h: CN_FONT_CHUNK_SIZE).
CHUNK_SIZE = 128

# 0x074x font-upload command family (App/app/uart.c).
CMD_FONT_INFO = 0x0740
RSP_FONT_INFO = 0x0741
CMD_FONT_WRITE = 0x0742
RSP_FONT_WRITE = 0x0743
CMD_FONT_READ = 0x0744
RSP_FONT_READ = 0x0745

CMD_DEV_INFO = 0x0514
RSP_DEV_INFO = 0x0515

# Status bytes of the font commands (App/cn_font.h).
STATUS_TEXT = {
    0: "OK",
    1: "authentication failed (run the radio firmware, then retry)",
    2: "offset/length outside the font region",
    3: "malformed request",
}

OBFUSCATION = bytes((
    0x16, 0x6C, 0x14, 0xE6, 0x2E, 0x91, 0x0D, 0x40,
    0x21, 0x35, 0xD5, 0x40, 0x13, 0x03, 0xE9, 0x80,
))

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_FONT_PATHS = (
    os.path.join(REPO_ROOT, "Dondji", "docs", "font", "cn_font.bin"),
    os.path.join(REPO_ROOT, "Dondji", "docs", "fonts", "cn_font.bin"),
    os.path.join(HERE, "cn_font.bin"),
)


def crc16_ccitt(data):
    """CRC-16/CCITT-FALSE (poly 0x1021, init 0), as used by App/driver/crc.c."""
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def obfuscate(data):
    return bytes(b ^ OBFUSCATION[i % 16] for i, b in enumerate(data))


class FontError(Exception):
    pass


class Radio:
    """Host side of the radio's serial protocol."""

    def __init__(self, port, baud, timeout=2.0):
        try:
            import serial  # pyserial
        except ImportError:
            raise FontError(
                "pyserial is required: python -m pip install pyserial")

        self.serial = serial.Serial(port, baudrate=baud, timeout=timeout,
                                    write_timeout=timeout)
        self.timestamp = int(time.time()) & 0xFFFFFFFF

    def close(self):
        try:
            self.serial.close()
        except Exception:
            pass

    # -- framing ------------------------------------------------------------

    def _build(self, cmd_id, payload):
        """AB CD | size | obf(header + payload + crc) | DC BA"""
        body = struct.pack("<HH", cmd_id, len(payload)) + payload
        frame_size = len(body)
        body += struct.pack("<H", crc16_ccitt(body))
        return b"\xAB\xCD" + struct.pack("<H", frame_size) + obfuscate(body) + b"\xDC\xBA"

    def _read_reply(self, expect_id, overall_timeout=5.0):
        """The radio answers with AB CD | size | obf(header + data) | pad2 | DC BA."""
        deadline = time.time() + overall_timeout
        buf = bytearray()

        while time.time() < deadline:
            chunk = self.serial.read(1)
            if not chunk:
                continue

            buf += chunk

            # Keep only the tail: we are looking for a frame start.
            if len(buf) > 512:
                del buf[:-512]

            while True:
                start = buf.find(b"\xAB\xCD")
                if start < 0:
                    break
                if len(buf) - start < 6:
                    break

                size = struct.unpack_from("<H", buf, start + 2)[0]
                if size == 0 or size > 256:
                    # Not a frame header after all: skip it and resync.
                    del buf[:start + 1]
                    continue

                need = 4 + size + 4          # header + body + pad2 + 0xDCBA
                if len(buf) - start < need:
                    break

                body = obfuscate(bytes(buf[start + 4:start + 4 + size]))
                tail = bytes(buf[start + need - 2:start + need])
                if tail != b"\xDC\xBA":
                    del buf[:start + 1]
                    continue

                del buf[:start + need]

                if size < 4:
                    continue

                reply_id, data_len = struct.unpack_from("<HH", body, 0)
                if reply_id != expect_id:
                    continue

                return body[4:4 + data_len]

        raise FontError("no reply from the radio (0x%04X)" % expect_id)

    def _request(self, cmd_id, payload, expect_id, retries=3):
        for attempt in range(retries):
            self.serial.reset_input_buffer()
            self.serial.write(self._build(cmd_id, payload))
            self.serial.flush()
            try:
                return self._read_reply(expect_id)
            except FontError:
                if attempt + 1 == retries:
                    raise
                time.sleep(0.2)

        raise FontError("no reply from the radio (0x%04X)" % expect_id)

    # -- protocol -----------------------------------------------------------

    def handshake(self):
        """0x0514 latches the session timestamp every write command is checked
        against. The bootloader does not answer it."""
        data = self._request(CMD_DEV_INFO, struct.pack("<I", self.timestamp),
                             RSP_DEV_INFO)
        return data[:16].split(b"\x00")[0].decode("ascii", "replace")

    def font_info(self):
        data = self._request(CMD_FONT_INFO, struct.pack("<I", self.timestamp),
                             RSP_FONT_INFO)
        if len(data) < 9:
            raise FontError("short reply to the font info command")
        present, version, status = data[0], data[1], data[2]
        size, chars = struct.unpack_from("<IH", data, 3)
        if status != 0:
            raise FontError("font info refused: %s" % STATUS_TEXT.get(status, status))
        return {"present": bool(present), "version": version,
                "size": size, "characters": chars}

    def write_chunk(self, offset, blob):
        payload = struct.pack("<IH", offset, len(blob)) + \
            struct.pack("<I", self.timestamp) + blob
        data = self._request(CMD_FONT_WRITE, payload, RSP_FONT_WRITE)
        if len(data) < 7:
            raise FontError("short reply to a font write")
        _, written, status = struct.unpack_from("<IHB", data, 0)
        if status != 0:
            raise FontError("write at %d refused: %s" %
                            (offset, STATUS_TEXT.get(status, status)))
        if written != len(blob):
            raise FontError("write at %d: radio reports %d of %d bytes" %
                            (offset, written, len(blob)))

    def read_chunk(self, offset, length):
        payload = struct.pack("<IH", offset, length) + struct.pack("<I", self.timestamp)
        data = self._request(CMD_FONT_READ, payload, RSP_FONT_READ)
        if len(data) < 7:
            raise FontError("short reply to a font read")
        _, read_len, status = struct.unpack_from("<IHB", data, 0)
        if status != 0:
            raise FontError("read at %d refused: %s" %
                            (offset, STATUS_TEXT.get(status, status)))
        return data[7:7 + read_len]


def pick_font_file(explicit):
    if explicit:
        return explicit

    for candidate in DEFAULT_FONT_PATHS:
        if os.path.isfile(candidate):
            return candidate

    raise FontError(
        "no font file found; pass --file (looked for: %s)" %
        ", ".join(DEFAULT_FONT_PATHS))


def check_blob(blob):
    """Sanity-check the blob against cn_font.h before spending a minute on the
    upload: a mismatched file would render the wrong characters silently."""
    if len(blob) != CN_FONT_TOTAL_SIZE:
        raise FontError("font file is %d bytes, expected %d" %
                        (len(blob), CN_FONT_TOTAL_SIZE))

    bitmap_size = len(blob[:CN_FONT_BITMAP_SIZE])
    if bitmap_size != CN_FONT_BITMAP_SIZE:
        raise FontError("bitmap region is truncated")

    if blob[CN_FONT_VERSION_OFFSET] != CN_FONT_VERSION:
        raise FontError("version byte is %d, expected %d" %
                        (blob[CN_FONT_VERSION_OFFSET], CN_FONT_VERSION))

    first = struct.unpack_from("<HH", blob, 0)
    if first != (0x1100, 0x2100):
        raise FontError("first glyph is 0x%04X 0x%04X, expected 0x1100 0x2100" % first)

    # Index entry: uint32 little endian, (unicode << 16) | bitmap slot.
    entry = struct.unpack_from("<I", blob, CN_FONT_BITMAP_SIZE)[0]
    first_unicode = entry >> 16
    if not 0x4E00 <= first_unicode <= 0x9FFF:
        raise FontError("first index entry is U+%04X, expected a CJK ideograph" %
                        first_unicode)

    return True


def upload(radio, blob, verify, quiet=False):
    total = len(blob)
    started = time.time()

    for offset in range(0, total, CHUNK_SIZE):
        radio.write_chunk(offset, blob[offset:offset + CHUNK_SIZE])

        if not quiet:
            done = min(offset + CHUNK_SIZE, total)
            percent = (done * 100) // total
            elapsed = time.time() - started
            sys.stdout.write("\r  writing %3d%% (%d/%d bytes, %.0fs)" %
                             (percent, done, total, elapsed))
            sys.stdout.flush()

    if not quiet:
        sys.stdout.write("\n")

    if not verify:
        return True

    if not quiet:
        sys.stdout.write("  verifying ...")

    for offset in range(0, total, CHUNK_SIZE):
        expected = blob[offset:offset + CHUNK_SIZE]
        got = radio.read_chunk(offset, len(expected))
        if got != expected:
            if not quiet:
                sys.stdout.write("\n")
            raise FontError("verification failed at offset %d" % offset)

    if not quiet:
        sys.stdout.write(" ok\n")

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Upload the Chinese channel-name font to a UV-K1/K5 V3 "
                    "built with ENABLE_CHINESE.")
    parser.add_argument("--port", required=True,
                        help="serial port of the radio (COM7, /dev/ttyUSB0, ...)")
    parser.add_argument("--file", help="font blob to upload (default: the "
                        "reference blob shipped in Dondji/docs/font/cn_font.bin)")
    parser.add_argument("--baud", type=int, default=38400,
                        help="serial baud rate (default: 38400)")
    parser.add_argument("--info", action="store_true",
                        help="only report what font the radio currently holds")
    parser.add_argument("--no-verify", action="store_true",
                        help="skip reading the blob back afterwards")
    args = parser.parse_args()

    radio = None

    try:
        radio = Radio(args.port, args.baud)
        version = radio.handshake()
        print("radio: %s" % (version or "(no version string)"))

        info = radio.font_info()
        print("font: %s, version %d, %d characters, %d bytes expected" %
              ("present" if info["present"] else "absent",
               info["version"], info["characters"], info["size"]))

        if args.info:
            return 0

        font_path = pick_font_file(args.file)
        with open(font_path, "rb") as handle:
            blob = handle.read()

        check_blob(blob)
        print("uploading %s (%d bytes) to 0x%06X" %
              (font_path, len(blob), CN_FONT_FLASH_BASE))

        upload(radio, blob, verify=not args.no_verify)

        info = radio.font_info()
        if not info["present"]:
            print("upload finished but the radio still rejects the font",
                  file=sys.stderr)
            return 1

        print("done - Chinese channel names are available now")
        return 0

    except FontError as error:
        print("error: %s" % error, file=sys.stderr)
        return 1
    finally:
        if radio is not None:
            radio.close()


if __name__ == "__main__":
    sys.exit(main())
