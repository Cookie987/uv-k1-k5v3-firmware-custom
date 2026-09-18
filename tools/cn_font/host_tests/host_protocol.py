#!/usr/bin/env python3
"""Host test for the font upload protocol: simulates the radio's serial parser
and reply builder (App/app/uart.c) and checks that upload_cn_font.py speaks it
correctly.

    python host_protocol.py --blob <cn_font.bin> [--tools <tools/cn_font>]
"""

import argparse
import importlib.util
import os
import struct
import sys

# Loading the uploader must not leave a __pycache__ behind in the repository.
sys.dont_write_bytecode = True

MAX_REPLY_SIZE = 144


def load_uploader(tools_dir):
    path = os.path.join(tools_dir, "upload_cn_font.py")
    spec = importlib.util.spec_from_file_location("upload_cn_font", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["upload_cn_font"] = module
    spec.loader.exec_module(module)
    return module


def fw_parse_frame(ucf, buf):
    """Mirror UART_IsCommandAvailable(): AB CD | size | obf(payload+crc) | DC BA."""
    assert buf[0] == 0xAB and buf[1] == 0xCD, "bad magic"
    size = struct.unpack_from("<H", buf, 2)[0]
    total = 4 + size + 2 + 2
    assert len(buf) == total, "frame length %d, expected %d" % (len(buf), total)

    body = ucf.obfuscate(buf[4:4 + size + 2])
    assert buf[total - 2:total] == b"\xDC\xBA", "bad tail"

    crc = struct.unpack_from("<H", body, size)[0]
    assert crc == ucf.crc16_ccitt(body[:size]), "bad crc"

    cmd_id, data_len = struct.unpack_from("<HH", body, 0)
    assert data_len <= size - 4, "command header size exceeds the payload"
    return cmd_id, body[4:4 + data_len]


def fw_build_reply(ucf, reply_id, data):
    """Mirror SendReply(): AB CD | size | obf(header+data) | pad2 | DC BA."""
    body = struct.pack("<HH", reply_id, len(data)) + data
    size = len(body)
    pad = bytes((ucf.OBFUSCATION[(size + i) % 16] ^ 0xFF for i in range(2)))
    return (b"\xAB\xCD" + struct.pack("<H", size) + ucf.obfuscate(body) +
            pad + b"\xDC\xBA")


class FakeSerial:
    """Consumes host frames and answers the way the firmware would."""

    def __init__(self, ucf, flash):
        self.ucf = ucf
        self.flash = flash
        self.rx = bytearray()
        self.tx = bytearray()
        self.timestamp = None
        self.info_present = False

    # -- pyserial-ish API used by Radio ------------------------------------
    @property
    def timeout(self):
        return 1.0

    def write(self, data):
        self.rx += data

    def flush(self):
        while len(self.rx) >= 6:
            size = struct.unpack_from("<H", self.rx, 2)[0]
            if len(self.rx) < 4 + size + 4:
                return
            frame = bytes(self.rx[:4 + size + 4])
            del self.rx[:4 + size + 4]
            self.handle(*fw_parse_frame(self.ucf, frame))

    def read(self, count):
        out = bytes(self.tx[:count])
        del self.tx[:count]
        return out

    def reset_input_buffer(self):
        self.rx.clear()

    def close(self):
        pass

    # -- firmware behaviour -------------------------------------------------
    def handle(self, cmd_id, data):
        ucf = self.ucf

        if cmd_id == ucf.CMD_DEV_INFO:
            self.timestamp = struct.unpack_from("<I", data, 0)[0]
            payload = b"v6.0.0-test".ljust(16, b"\0") + b"\0" * 20
            self.tx += fw_build_reply(ucf, ucf.RSP_DEV_INFO, payload)

        elif cmd_id == ucf.CMD_FONT_INFO:
            ts = struct.unpack_from("<I", data, 0)[0]
            status = 0 if ts == self.timestamp else 1
            payload = struct.pack("<BBB", 1 if self.info_present else 0,
                                  ucf.CN_FONT_VERSION, status)
            payload += struct.pack("<IH", ucf.CN_FONT_TOTAL_SIZE,
                                   ucf.CN_FONT_CHAR_COUNT)
            self.tx += fw_build_reply(ucf, ucf.RSP_FONT_INFO, payload)

        elif cmd_id == ucf.CMD_FONT_WRITE:
            offset, length = struct.unpack_from("<IH", data, 0)
            ts = struct.unpack_from("<I", data, 6)[0]
            chunk = data[10:10 + length]

            if ts != self.timestamp:
                status = 1
            elif length != len(data) - 10 or length > ucf.CHUNK_SIZE:
                status = 3
            elif offset > ucf.CN_FONT_TOTAL_SIZE or length > ucf.CN_FONT_TOTAL_SIZE - offset:
                status = 2
            else:
                status = 0
                self.flash[offset:offset + length] = chunk
                self.info_present = (len(self.flash) >= ucf.CN_FONT_TOTAL_SIZE and
                                     self.flash[ucf.CN_FONT_VERSION_OFFSET] ==
                                     ucf.CN_FONT_VERSION)

            self.tx += fw_build_reply(ucf, ucf.RSP_FONT_WRITE,
                                      struct.pack("<IHB", offset,
                                                  length if status == 0 else 0,
                                                  status))

        elif cmd_id == ucf.CMD_FONT_READ:
            offset, length = struct.unpack_from("<IH", data, 0)
            ts = struct.unpack_from("<I", data, 6)[0]

            if ts != self.timestamp:
                status, body = 1, b""
            elif length == 0 or length > MAX_REPLY_SIZE - 11:
                status, body = 3, b""
            elif offset > ucf.CN_FONT_TOTAL_SIZE or length > ucf.CN_FONT_TOTAL_SIZE - offset:
                status, body = 2, b""
            else:
                status = 0
                body = bytes(self.flash[offset:offset + length])

            self.tx += fw_build_reply(ucf, ucf.RSP_FONT_READ,
                                      struct.pack("<IHB", offset, len(body), status) + body)
        else:
            raise AssertionError("unexpected command 0x%04X" % cmd_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blob", required=True)
    parser.add_argument("--tools", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = parser.parse_args()

    failures = 0

    def check(condition, what):
        nonlocal failures
        print("%s %s" % ("ok  " if condition else "FAIL", what))
        if not condition:
            failures += 1

    ucf = load_uploader(args.tools)

    with open(args.blob, "rb") as handle:
        blob = handle.read()

    ucf.check_blob(blob)
    check(True, "blob passes the pre-upload validation")

    flash = bytearray(b"\xFF" * ucf.CN_FONT_TOTAL_SIZE)
    serial = FakeSerial(ucf, flash)

    radio = ucf.Radio.__new__(ucf.Radio)
    radio.serial = serial
    radio.timestamp = 0x12345678

    check(radio.handshake() == "v6.0.0-test", "device-info handshake")

    info = radio.font_info()
    check(info["present"] is False, "a radio without a font reports none")
    check(info["size"] == ucf.CN_FONT_TOTAL_SIZE and
          info["characters"] == ucf.CN_FONT_CHAR_COUNT,
          "font info advertises the expected layout")

    ucf.upload(radio, blob, verify=True, quiet=True)
    check(bytes(flash) == blob, "upload writes the exact blob, verified by read-back")

    check(radio.font_info()["present"] is True, "the radio accepts the font afterwards")

    # A stale session must be refused.
    radio.timestamp = 0xDEADBEEF
    try:
        radio.write_chunk(0, blob[:ucf.CHUNK_SIZE])
        check(False, "a stale session is refused")
    except ucf.FontError:
        check(True, "a stale session is refused")

    # Out-of-range writes must be refused.
    radio.timestamp = serial.timestamp
    try:
        radio.write_chunk(ucf.CN_FONT_TOTAL_SIZE - 4, b"\x00" * 16)
        check(False, "an out-of-range write is refused")
    except ucf.FontError:
        check(True, "an out-of-range write is refused")

    # A blob that does not match the firmware must be rejected before uploading.
    for broken, label in ((blob[:-1], "a short blob"),
                          (blob[:-1] + b"\x03", "a blob with the wrong version"),
                          (b"\x00" * len(blob), "a blob with the wrong probe glyph")):
        try:
            ucf.check_blob(broken)
            check(False, "%s is rejected" % label)
        except ucf.FontError:
            check(True, "%s is rejected" % label)

    print("\n%s (%d failure%s)" % ("all protocol checks passed" if failures == 0
                                   else "FAILED", failures, "" if failures == 1 else "s"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
