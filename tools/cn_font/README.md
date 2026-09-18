# Chinese channel names

The `ENABLE_CHINESE` build option adds UTF-8 channel names: a memory channel can
be named with Hanzi mixed with Latin characters. Names are written from the host
(`tools/webflash/`), where a keyboard and an IME are available; the radio draws
them and can still edit them character by character.

Everything Chinese-specific that is *data* rather than code lives in the
external SPI flash, not in the firmware:

| | |
|---|---|
| internal application flash | 118 KiB, and the release editions are 88-95 % full |
| font blob | 205 367 bytes (6766 glyphs + an unused pinyin table) |
| where it lives | external PY25Q16 flash at `0x1AD000`, ending at `0x1DF237` |

`App/cn_font.h` holds the layout constants (and the map of its neighbours); the
blob itself is a separate artifact. A radio that never received one still runs the
firmware normally, it just cannot draw Hanzi (a name that holds Hanzi then shows
as blank in the name band, and ASCII names are unaffected).

The address is picked so that nothing else gets overwritten — the external flash
above the config-bank boundary already holds the multiboot markers, the overlay-app
slots (Labs, `0x102000`..`0x122000`), the voice resource and the RX/TX log
(`0x1E0000`). `App/cn_font.c` carries static assertions against the app region and
the log, so a future layout change fails the build instead of silently corrupting
one of them.

## Uploading the font

There are two host tools: the web tool (`tools/webflash/`, which also does channel
programming) and this command-line uploader.

The firmware answers three extra serial commands in this build (`0x0740` info,
`0x0742` write, `0x0744` read back), and `upload_cn_font.py` drives them:

```sh
python -m pip install pyserial
python tools/cn_font/upload_cn_font.py --port COM7          # or /dev/ttyUSB0
python tools/cn_font/upload_cn_font.py --port COM7 --info   # what is on the radio
```

Notes:

- The **radio must be running the firmware**, not sitting in the bootloader
  (the bootloader does not implement these commands).
- The upload takes about a minute at 38 400 baud; `--no-verify` skips the
  read-back check.
- The blob is written front to back and the version byte is its last byte, so an
  interrupted upload is rejected at the next boot instead of leaving you with
  half a font. Just run it again (the web tool resumes from where it stopped).
- The region lies above the config-bank boundary, so every multiboot slot and
  every config bank shares one copy. Uploading the font once is enough, and it
  survives flashing new firmware. It does **not** survive a full external-flash
  wipe or a restore of an older dump.
- If you enabled `ENABLE_VOICE`, a large voice pack shares the same stretch of
  flash and the two cannot coexist; the font sits at the top of it, just below the
  RX/TX log.

## Editing a Chinese name on the radio

Names are normally written from the host tool, where the browser IME does the
character work (`tools/webflash/`). The radio's own editor stays available for
small fixes:

`ChName` → MENU (opens the item) → MENU again (starts the editor).

- A name that contains Hanzi opens the CJK editor: every character is drawn in
  its own cell with the cursor caret under it, and UP/DOWN (or the digit keys)
  move by whole characters, so the cursor can never land inside a Hanzi.
- Typing an ASCII character over a Hanzi blanks the whole Hanzi, so a partially
  overwritten character can never end up in the stored name.
- The editor still types Latin with the digit keys as before; **F** toggles the
  letter case and a long press types `#`. **EXIT** deletes the character behind
  the cursor.
- There is no Hanzi input on the radio: to add or change Chinese characters, use
  the web tool.

## Where the blob comes from


The default font file is the reference implementation's binary,
`Dondji/docs/font/cn_font.bin` (WenQuanYi Bitmap Song 9pt, 12x12, the 6766
characters covered by `Dondji/App/tools/cn_chars_append.txt`). Its layout is
what `App/cn_font.h` documents, so it can be used as-is:

```
+0x000000  bitmaps  6766 x 12 x uint16 LE, MSB = leftmost pixel
+0x027A50  index    6766 x uint32 LE, (unicode << 16) | bitmap slot, sorted by unicode
+0x02E408  pinyin   402 entries: [len][syllable][len][unicode:2 BE]...
+0x032236  version  1 byte, 2
```

To change the character set, use the generator in the reference checkout
(`Dondji/App/tools/gen_cn_font.py`, which reads `Dondji/App/bdf/wenquanyi_9pt.bdf`)
and pass the resulting `.bin`:

```sh
python tools/cn_font/upload_cn_font.py --port COM7 --file /path/to/cn_font.bin
```

If the layout ever changes, bump `CN_FONT_VERSION` in `App/cn_font.h` **and** in
the generator: the firmware verifies the version byte plus a probe glyph at boot,
and refuses a font it does not recognise. The host tool runs the same checks
before uploading, so a mismatched file is rejected before it reaches the radio.

## Testing without a radio

`host_tests/run_host_tests.py` builds the real firmware sources for the host (a
stubbed external flash serving the blob, a stubbed serial port that parses and
answers frames exactly like `App/app/uart.c` does) and checks:

- the font layer and the mixed CJK/Latin drawing helpers, pixel by pixel,
  including the page crossing at LCD row 16,
- the name storage: UTF-8 round trip, the 15-byte cap on character boundaries,
  legacy 10-character records and erased slots,
- the name editor cursor: slot arithmetic over mixed Hanzi/Latin names and
  replacing a Hanzi with an ASCII character,
- the upload protocol against a simulated radio.

```sh
python tools/cn_font/host_tests/run_host_tests.py
python tools/cn_font/host_tests/run_host_tests.py --blob my_cn_font.bin
```

The channel-name functions are extracted verbatim from `App/settings.c` and
`App/app/menu.c` at test time, so the tests follow the sources instead of a copy.
A host compiler (`gcc`, `cc` or `clang`) has to be on `PATH`; `--art` on
`host_font` dumps a rendered name as ASCII art.

## How it fits together in the firmware

| Concern | Where |
|---|---|
| font access from the external flash, UTF-8 helpers | `App/cn_font.c` / `cn_font.h` |
| boot-time probe and "is a font present" flag | `CN_FONT_Init()`, called from `App/main.c` |
| name storage (15-byte UTF-8 payload in the existing 16-byte slot) | `SETTINGS_FetchChannelName` / `SETTINGS_SaveChannelName` in `App/settings.c` |
| mixed CJK/Latin LCD rendering | `UI_PrintStringSmallAtPixel`, `UI_PrintStringSmallChannelNameBand` in `App/ui/helper.c` |
| name editor logic (`MENU_MEM_NAME` handling) | `App/app/menu.c` |
| editor drawing | `App/ui/menu.c` (`UI_MENU_DrawCnNameEditor`) |
| upload commands | the `0x074x` family in `App/app/uart.c` |
| host side: names and the font | `tools/webflash/`, `tools/cn_font/upload_cn_font.py` |

### Known limits

- The spectrum status bar is a single 8-pixel page drawn with the ASCII font, so
  it shows nothing for a Chinese name rather than a broken bitmap.
- The K5Viewer log rows and the Triple-VFO overlay ABI carry fixed 10-byte ASCII
  fields, so those also drop a Chinese name instead of corrupting it.
- On the main screen, what is shown follows the Display Setting, as it does for
  ASCII names:
  - `NAME` — the 12-pixel Hanzi fill the whole value block; the small line below
    keeps showing the step (the setting asked for the name alone).
  - `NAME+FREQ` — the Hanzi take the value block and the frequency moves to that
    small 3x5 line, in the slot the step normally occupies (the step means
    nothing while a channel name is on screen). In the Tiny display style that
    slot is shared with the tone, and the frequency wins there too: it is drawn
    over the tone label and value, in a compact form slid left so it cannot reach
    the bandwidth label.
  - `FREQUENCY` and `CHANNEL` do not show the name, so they are unaffected.
- A name is capped at 15 bytes, which is 5 Hanzi or 15 ASCII characters. The
  cap is enforced on whole characters, so a sequence is never split.
