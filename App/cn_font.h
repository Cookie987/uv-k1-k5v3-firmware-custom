/* Copyright 2026 Armel F4HWN
 * https://github.com/armel
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Chinese (UTF-8) channel names - bitmap font access.
 *
 * A 12x12 WenQuanYi bitmap font is kept in the external
 * PY25Q16 SPI flash. It is far too large for the 118 KiB internal application
 * flash (the blob is ~200 KiB), and the external flash already holds the font
 * region budget for it: the font lives in the free area of the 2 MiB part, above
 * the config-bank boundary, so every config bank and every multiboot slot shares
 * one copy (see the flash map in driver/mb_flash.h).
 *
 * The blob layout is byte-for-byte the one produced by the reference
 * implementation shipped in the Dondji/ folder (App/tools/gen_cn_font.py), so a
 * cn_font.bin built there can be uploaded here unchanged:
 *
 *   +0x000000  bitmaps  6766 x 12 x uint16 (little endian)
 *              one 16-bit word per glyph row, MSB = leftmost pixel
 *   +0x027A50  index    6766 x uint32 (little endian), (unicode << 16) | slot
 *              sorted by unicode, so a lookup is a binary search
 *   +0x02E408  pinyin   402 entries, each
 *              [len:1][syllable ASCII:len][count:1][unicode:2 BE, count times]
 *              sorted by syllable
 *   +0x032236  version  1 byte == CN_FONT_VERSION (last byte of the blob)
 *
 * The firmware only carries these constants; it never carries the glyphs. The
 * pinyin table is present in the blob but unused: names are written on the host
 * (tools/webflash/), where a real keyboard and IME are available, so the radio
 * only has to *draw* Hanzi.
 *
 * Nothing is drawn until CN_FONT_Init() has confirmed that a matching blob is
 * present, so an unprogrammed radio simply keeps showing ASCII names.
 */

#ifndef CN_FONT_H
#define CN_FONT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Blob base inside the external SPI flash.
 *
 * Where this may live is decided by everything else in the 2 MiB PY25Q16, so the
 * neighbours are listed here - trusting a single summary comment is how a font
 * once landed on top of the overlay-app slots (0x102000). The current tenants
 * above the config-bank boundary:
 *
 *   0x00100000  multiboot state A                       driver/mb_flash.h
 *   0x00101000  multiboot state B                       driver/mb_flash.h
 *   0x00102000  overlay apps, 16 x 8 KiB -> 0x00122000  apps/app_overlay.h
 *   0x0014C000  voice clip index tables                 app/audio.c
 *   0x0014D000  voice clip data (ENABLE_VOICE)         app/audio.c
 *   0x001AD000  the Chinese font  <- this              cn_font.h
 *   0x001E0000  RX/TX log, 32 KiB -> 0x001E8000        app/rxtx_log.c
 *
 * CN_FONT_FLASH_BASE must stay 4 KiB aligned and CN_FONT_FLASH_END must stay
 * below the RX/TX log: cn_font.c carries static assertions that fail the build
 * otherwise. The region is above PY25Q16_BANK_SHARED_FROM, so every config bank
 * and every multiboot slot shares this one copy.
 *
 * ENALBLE_VOICE (off in every shipped preset) is the one feature that shares the
 * space: a voice pack large enough to reach 0x001AD000 would collide, and the
 * same pack would already be past the firmware's own 0x001E0000 log guard. */
#define CN_FONT_FLASH_BASE      0x001AD000u

#define CN_FONT_CHAR_COUNT      6766u
#define CN_FONT_BITMAP_SIZE     162384u   /* 6766 x 12 x 2                     */
#define CN_FONT_INDEX_SIZE      27064u    /* 6766 x 4                          */
#define CN_FONT_PY_OFFSET       189448u   /* CN_FONT_BITMAP_SIZE + CN_FONT_INDEX_SIZE */
#define CN_FONT_PY_COUNT        402u
#define CN_FONT_PY_TOTAL_SIZE   15918u
#define CN_FONT_VERSION         2u
#define CN_FONT_VERSION_OFFSET  205366u   /* CN_FONT_PY_OFFSET + CN_FONT_PY_TOTAL_SIZE */
#define CN_FONT_TOTAL_SIZE      205367u   /* CN_FONT_VERSION_OFFSET + 1        */
#define CN_FONT_FLASH_END       (CN_FONT_FLASH_BASE + CN_FONT_TOTAL_SIZE)

/* One glyph: 12 rows of 12 pixels, 2 bytes per row. */
#define CN_FONT_GLYPH_ROWS      12u
#define CN_FONT_GLYPH_WIDTH     12u
#define CN_FONT_GLYPH_BYTES     24u

/* Largest payload of one font-upload command (see the 0x074x family in
 * app/uart.c, and tools/cn_font/upload_cn_font.py on the host side). */
#define CN_FONT_CHUNK_SIZE      128u

/* Status byte of the font upload commands. */
enum {
    CN_FONT_OK = 0,
    CN_FONT_ERR_AUTH,      /* session timestamp mismatch        */
    CN_FONT_ERR_RANGE,     /* offset/length outside the region  */
    CN_FONT_ERR_SIZE       /* malformed request                */
};

/* Probe the font region once, right after boot. Sets the internal
 * "font present" flag used by every other entry point. */
void    CN_FONT_Init(void);

/* True when CN_FONT_Init() found a valid, version-matching blob. */
bool    CN_FONT_IsPresent(void);

/* Unicode -> bitmap slot. Returns -1 when the character is not in the font. */
int16_t CN_FONT_UnicodeToIndex(uint16_t Unicode);

/* Read the 12x12 bitmap of a slot into 12 host-endian uint16_t words. */
void    CN_FONT_ReadBitmap(uint16_t CharIndex, uint16_t *pBitmap);

/* Bytes of the character starting at pString: 3 for a (valid) 3-byte UTF-8
 * sequence, else 1. */
uint8_t CN_FONT_CharSize(const char *pString);

uint16_t CN_FONT_Utf8ToUnicode(const char *pString);
void     CN_FONT_UnicodeToUtf8(uint16_t Unicode, char *pOut);

bool     CN_FONT_StringHasCjk(const char *pString);

/* Rendered width in pixels of a mixed CJK/ASCII string, following the metrics
 * used by ui/helper.c: 12+1 px per Hanzi, 6+1 px per Latin character. */
size_t   CN_FONT_PixelWidth(const char *pString);

#endif
