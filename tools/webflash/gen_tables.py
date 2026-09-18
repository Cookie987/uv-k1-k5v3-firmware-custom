#!/usr/bin/env python3
"""Regenerate js/tables.js from the firmware's C sources.

The web tool needs the same CTCSS/DCS code tables, power/modulation/step labels
and flash-layout constants the firmware uses. Transcribing them by hand would rot
silently, so they are parsed out of the C sources here and emitted as a plain
script; the host test re-runs this generator and fails if the committed file is
stale.

    python tools/webflash/gen_tables.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))

OUT = os.path.join(HERE, "js", "tables.js")


def read(rel_path):
    with open(os.path.join(REPO, rel_path), encoding="utf-8", errors="replace") as handle:
        return handle.read()


def build_flags():
    """The hidden `default` configure preset's options: the C sources guard parts
    of their tables with #ifdef, and the released editions inherit this preset."""
    with open(os.path.join(REPO, "CMakePresets.json"), encoding="utf-8") as handle:
        presets = json.load(handle)

    for preset in presets["configurePresets"]:
        if preset["name"] == "default":
            return preset.get("cacheVariables", {})

    return {}


def strip_inactive(text, flags):
    """Drop the parts of a table that this build config compiles out, so the
    parsed values match the firmware instead of every possible variant."""
    out = []
    stack = []

    for line in text.splitlines():
        match = re.match(r"\s*#\s*(ifdef|ifndef|if|else|elif|endif)\b\s*([A-Za-z_]\w*)?", line)

        if match:
            kind, name = match.group(1), match.group(2)

            if kind == "ifdef":
                stack.append(bool(flags.get(name, False)))
            elif kind == "ifndef":
                stack.append(not bool(flags.get(name, False)))
            elif kind == "if":
                stack.append(True)          # expressions are left as-is
            elif kind == "else" and stack:
                stack[-1] = not stack[-1]
            elif kind == "endif" and stack:
                stack.pop()
            continue

        if all(stack):
            out.append(line)

    return "\n".join(out)


def strip_comments(text):
    """C comments only; string literals are left alone (labels may contain //)."""
    out = []
    i = 0
    in_string = False
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = len(text) if j < 0 else j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = len(text) if j < 0 else j + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def block_of(text, name):
    """The brace-balanced {...} that follows `name ... =`."""
    match = re.search(r"\b%s\b[^;{=]*=\s*\{" % re.escape(name), text)
    if not match:
        raise SystemExit("array not found: %s" % name)

    start = text.index("{", match.start())
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    raise SystemExit("unbalanced braces in %s" % name)


def int_array(text, name, flags=None):
    """Integer array. Returns a name->value dict when every entry is designated
    (`[NAME] = value`), otherwise the plain ordered list."""
    block = strip_comments(block_of(text, name))

    if flags is not None:
        block = strip_inactive(block, flags)

    values = {}
    ordered = []

    for entry in block.split(","):
        match = re.fullmatch(
            r"\s*(?:\[([A-Za-z_0-9]+)\]\s*=\s*)?(0[xX][0-9A-Fa-f]+|\d+)\s*", entry)
        if not match:
            continue
        designator, value = match.group(1), int(match.group(2), 0)
        ordered.append(value)
        if designator is not None:
            values[designator] = value

    if values and len(values) == len(ordered):
        # Fully designated: keep the designator names for the caller.
        return values

    return ordered


def string_array(text, name, flags=None):
    block = block_of(text, name)

    if flags is not None:
        block = strip_inactive(block, flags)

    return [m.group(1) for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', block)]


def designated_strings(text, name, flags=None):
    block = block_of(text, name)

    if flags is not None:
        block = strip_inactive(block, flags)

    out = {}

    for match in re.finditer(r"\[([A-Za-z_0-9]+)\]\s*=\s*\"((?:[^\"\\]|\\.)*)\"", block):
        out[match.group(1)] = match.group(2)

    return out


def enum_blocks(text):
    """Every `enum ... { ... }` body in the file (named or anonymous typedef)."""
    for match in re.finditer(r"\benum\b[^{;]*\{", text):
        start = text.index("{", match.start())
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    yield text[start + 1:i]
                    break


def parse_enum_body(body):
    values = {}
    nxt = 0
    for entry in strip_comments(body).split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" in entry:
            name, value = entry.split("=", 1)
            name, value = name.strip(), value.strip()
            try:
                nxt = int(value, 0)
            except ValueError:
                continue
        else:
            name = entry
        if re.fullmatch(r"[A-Za-z_]\w*", name):
            values[name] = nxt
            nxt += 1
    return values


def enum_by_member(text, member, flags=None):
    """The enum that declares `member` (the firmware mostly uses anonymous enums)."""
    for body in enum_blocks(text):
        if re.search(r"\b%s\b" % re.escape(member), body):
            if flags is not None:
                body = strip_inactive(body, flags)
            return parse_enum_body(body)
    raise SystemExit("no enum declares %s" % member)


def designated_ranges(text, name, flags=None):
    """`[DESIGNATOR] = {.lower = N, .upper = M}` entries, with macro values
    resolved from the file's own #defines."""
    block = strip_comments(block_of(text, name))

    if flags is not None:
        block = strip_inactive(block, flags)

    macros = {}

    for match in re.finditer(r"#\s*define\s+([A-Za-z_]\w*)\s+([0-9xXa-fA-F]+)\s*$", text, re.M):
        macros[match.group(1)] = int(match.group(2), 0)

    def value_of(token):
        token = token.strip()

        if re.fullmatch(r"0[xX][0-9A-Fa-f]+|\d+", token):
            return int(token, 0)

        return macros.get(token)

    out = {}

    for entry in re.finditer(r"\[([A-Za-z_0-9]+)\s*\]\s*=\s*\{([^}]*)\}", block):
        fields = {}

        for field in re.finditer(r"\.(\w+)\s*=\s*([A-Za-z_0-9]+)", entry.group(2)):
            fields[field.group(1)] = value_of(field.group(2))

        out[entry.group(1)] = fields

    return out


def define(text, name):
    match = re.search(r"#\s*define\s+%s\s+([0-9xXa-fA-FuUlL\(\)\s\+\*]+?)(?:\s*/\*|\s*//|\n)" % re.escape(name),
                      text)
    if not match:
        raise SystemExit("define not found: %s" % name)

    expr = match.group(1).strip().rstrip("uUlL")
    expr = expr.replace("u", "").replace("U", "").replace("L", "")
    try:
        return int(expr, 0)
    except ValueError:
        return eval(expr, {"__builtins__": {}}, {})   # simple arithmetic only


def build():
    flags = build_flags()

    dcs_c = read(os.path.join("App", "dcs.c"))
    dcs_h = read(os.path.join("App", "dcs.h"))
    menu_c = read(os.path.join("App", "ui", "menu.c"))
    radio_c = read(os.path.join("App", "radio.c"))
    radio_h = read(os.path.join("App", "radio.h"))
    settings_h = read(os.path.join("App", "settings.h"))
    misc_h = read(os.path.join("App", "misc.h"))
    misc_c = read(os.path.join("App", "misc.c"))
    cn_font_h = read(os.path.join("App", "cn_font.h"))
    frequencies_h = read(os.path.join("App", "frequencies.h"))
    frequencies_c = read(os.path.join("App", "frequencies.c"))

    step_values = int_array(frequencies_c, "gStepFrequencyTable", flags)
    step_names = list(enum_by_member(frequencies_h, "STEP_2_5kHz", flags).items())
    step_names.sort(key=lambda kv: kv[1])
    steps = [None] * (max(v for _, v in step_names) + 1)
    for name, index in step_names:
        if name in step_values:
            steps[index] = {"name": name, "hz100": step_values[name]}
    steps = [s for s in steps if s is not None]

    modulation = enum_by_member(radio_h, "MODULATION_FM", flags)
    code_type = enum_by_member(dcs_h, "CODE_TYPE_OFF", flags)
    offset_dir = enum_by_member(settings_h, "TX_OFFSET_FREQUENCY_DIRECTION_OFF", flags)
    bandwidth = enum_by_member(radio_h, "BANDWIDTH_WIDE", flags)
    modulation_labels = designated_strings(radio_c, "gModulationStr", flags)

    # Bands, for the calibration field of a brand new channel: index by band,
    # value = lower bound in 10 Hz units (FREQUENCY_GetBand() uses `lower` only).
    band_enum = enum_by_member(frequencies_h, "BAND1_50MHz", flags)
    band_ranges = designated_ranges(frequencies_c, "frequencyBandTable", flags)

    band_count = 0
    for name, value in band_enum.items():
        if isinstance(value, int) and value >= 0 and name != "BAND_N_ELEM":
            band_count = max(band_count, value + 1)

    band_lower = [None] * band_count
    band_labels = [None] * band_count

    for name, value in band_enum.items():
        if not isinstance(value, int) or value < 0 or name == "BAND_N_ELEM":
            continue
        entry = band_ranges.get(name)
        if entry and entry.get("lower") is not None and value < band_count:
            band_lower[value] = entry["lower"]
            band_labels[value] = re.sub(r"^BAND\d+_", "", name)

    # Occupants of the external flash above the config-bank boundary. The Chinese
    # font is one of them, and picking an address that lands on another is a
    # silent data loss, so the tests compare the font against this list.
    overlay_h = read(os.path.join("App", "apps", "app_overlay.h"))
    rxtx_c = read(os.path.join("App", "app", "rxtx_log.c"))
    audio_c = read(os.path.join("App", "audio.c"))

    apps_base = define(overlay_h, "APP_REGION_BASE")
    apps_end = apps_base + define(overlay_h, "APP_SLOT_COUNT") * define(overlay_h, "APP_SLOT_STRIDE")
    voice_index = int(re.search(r"VOICE_PROMPT_CHINESE\s*\?\s*0x([0-9a-fA-F]+)", audio_c).group(1), 16)
    voice_data = int(re.search(r"0x([0-9a-fA-F]+)\s*\+\s*Info\.Offset", audio_c).group(1), 16)
    log_base = define(rxtx_c, "RXTX_LOG_FLASH_BASE")

    regions = {
        "kernel": [
            {"name": "multiboot state A", "base": 0x00100000, "end": 0x00101000},
            {"name": "multiboot state B", "base": 0x00101000, "end": 0x00102000},
            {"name": "overlay apps", "base": apps_base, "end": apps_end},
            {"name": "voice index", "base": voice_index, "end": voice_data},
            {"name": "voice data", "base": voice_data, "end": None},
            {"name": "RX/TX log", "base": log_base, "end": None},
        ],
        "overlayApps": {"base": apps_base, "end": apps_end},
        "voiceIndexBase": voice_index,
        "voiceDataBase": voice_data,
        "rxtxLogBase": log_base,
        "flashSize": 0x00200000,
    }

    tables = {
        "generatedFrom": [
            "App/dcs.c", "App/dcs.h", "App/frequencies.c", "App/frequencies.h",
            "App/misc.c", "App/misc.h", "App/radio.c", "App/radio.h",
            "App/settings.h", "App/ui/menu.c", "App/cn_font.h",
        ],
        "ctcssOptionsHz10": int_array(dcs_c, "CTCSS_Options"),
        "dcsOptions": int_array(dcs_c, "DCS_Options"),
        "powerLabels": string_array(menu_c, "gSubMenu_TXP"),
        "modulation": modulation,
        "modulationLabels": modulation_labels,
        "modulationCount": modulation.get("MODULATION_UKNOWN", len(modulation_labels)),
        "codeType": code_type,
        "offsetDirection": offset_dir,
        "steps": steps,
        "bandwidth": bandwidth,
        "bandLowerHz10": band_lower,
        "bandLabels": band_labels,
        "pttIdLabels": ["OFF", "BEGIN OF TX", "END OF TX", "BOTH", "APOLLO"],
        "mrChannelsMax": define(misc_h, "MR_CHANNELS_MAX"),
        "scanLists": define(misc_h, "MR_CHANNELS_LIST"),
        "recordSize": 16,
        "namesBase": 0x004000,
        "namesSlotSize": define(settings_h, "CHANNEL_NAME_SLOT_SIZE"),
        "nameMaxBytes": define(settings_h, "CHANNEL_NAME_MAX_BYTES"),
        "attrsBase": define(misc_c, "FLASH_CHANNEL_ATTR_BASE"),
        "attrsSize": define(misc_c, "FLASH_CHANNEL_ATTR_SIZE"),
        "eepromReadMax": 128,
        "eepromOffsetMax": 0x10000,
        "font": {
            "base": define(cn_font_h, "CN_FONT_FLASH_BASE"),
            "totalSize": define(cn_font_h, "CN_FONT_TOTAL_SIZE"),
            "charCount": define(cn_font_h, "CN_FONT_CHAR_COUNT"),
            "bitmapSize": define(cn_font_h, "CN_FONT_BITMAP_SIZE"),
            "indexSize": define(cn_font_h, "CN_FONT_INDEX_SIZE"),
            "pyOffset": define(cn_font_h, "CN_FONT_PY_OFFSET"),
            "pyCount": define(cn_font_h, "CN_FONT_PY_COUNT"),
            "pyTotalSize": define(cn_font_h, "CN_FONT_PY_TOTAL_SIZE"),
            "version": define(cn_font_h, "CN_FONT_VERSION"),
            "versionOffset": define(cn_font_h, "CN_FONT_VERSION_OFFSET"),
            "chunkSize": define(cn_font_h, "CN_FONT_CHUNK_SIZE"),
        },
        "cmd": {
            "devInfo": 0x0514, "devInfoRsp": 0x0515,
            "readEeprom": 0x051B, "readEepromRsp": 0x051C,
            "writeEeprom": 0x051D, "writeEepromRsp": 0x051E,
            "reset": 0x05DD,
            "fontInfo": 0x0740, "fontInfoRsp": 0x0741,
            "fontWrite": 0x0742, "fontWriteRsp": 0x0743,
            "fontRead": 0x0744, "fontReadRsp": 0x0745,
        },
        "status": {
            "ok": 0, "auth": 1, "range": 2, "size": 3,
        },
        # Regions above the config-bank boundary, so the tool (and its tests) can
        # tell whether a new address collides with something that is already
        # there. Every one of them names its owner in the firmware.
        "regions": regions,
    }
    return tables


def main():
    tables = build()
    payload = json.dumps(tables, indent=4, ensure_ascii=False)
    out_path = sys.argv[1] if len(sys.argv) > 1 else OUT

    header = (
        "/* Generated by tools/webflash/gen_tables.py - do not edit by hand.\n"
        " *\n"
        " * Values parsed from the firmware sources:\n"
        + "".join(" *   %s\n" % src for src in tables["generatedFrom"]) +
        " *\n"
        " * Re-run the generator after changing any of them; the host test fails\n"
        " * when this file is stale.\n"
        " */\n"
        "globalThis.WebFlashTables = "
    )

    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(header + payload + ";\n")

    print("wrote %s (%d bytes)" % (out_path, os.path.getsize(out_path)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
