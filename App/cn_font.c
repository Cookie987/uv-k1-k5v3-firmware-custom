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

#include <string.h>

#include "cn_font.h"
#include "driver/py25q16.h"

#ifdef ENABLE_FEAT_F4HWN_OVERLAY_APPS
    #include "apps/app_overlay.h"
#endif

/* The font may not overlap anything else in the external flash. Landing on the
 * overlay-app slots is a silent data loss (the font wins, the apps break), so the
 * layout is checked at build time rather than trusted to a comment. */
#ifdef ENABLE_FEAT_F4HWN_OVERLAY_APPS
_Static_assert(CN_FONT_FLASH_BASE >= APP_REGION_BASE + (APP_SLOT_COUNT * APP_SLOT_STRIDE),
               "CN_FONT_FLASH_BASE overlaps the overlay-app slots (apps/app_overlay.h)");
#endif

/* rxtx_log.c: RXTX_LOG_FLASH_BASE, and app/audio.c: the voice clip data starts at
 * 0x14D000 (only with ENABLE_VOICE, off in every shipped preset). */
_Static_assert(CN_FONT_FLASH_END <= 0x001E0000u,
               "the font runs into the RX/TX log (app/rxtx_log.c RXTX_LOG_FLASH_BASE)");
_Static_assert(CN_FONT_FLASH_BASE >= 0x0014D000u,
               "the font would overlap the voice clip data (app/audio.c)");

static bool bFontPresent;

/* One byte of the font blob. */
static uint8_t CN_FONT_ReadU8(uint32_t Offset)
{
    uint8_t Value;

    PY25Q16_ReadBuffer(CN_FONT_FLASH_BASE + Offset, &Value, sizeof(Value));

    return Value;
}

void CN_FONT_Init(void)
{
    uint16_t Probe[2];
    uint32_t FirstEntry;
    uint16_t FirstUnicode;

    bFontPresent = false;

    /* The blob is written by a host tool, so never trust it: a radio that was
     * never given a font (or holds a font from another generation) must keep
     * working, it just cannot draw Hanzi. */
    if (CN_FONT_ReadU8(CN_FONT_VERSION_OFFSET) != CN_FONT_VERSION)
        return;

    /* First two bitmap words of '的' (U+7684), the first glyph of the blob. */
    PY25Q16_ReadBuffer(CN_FONT_FLASH_BASE, Probe, sizeof(Probe));
    if (Probe[0] != 0x1100u || Probe[1] != 0x2100u)
        return;

    /* First index entry must be a CJK ideograph: catches a blob built with
     * different index offsets, which would otherwise silently render the wrong
     * characters. */
    PY25Q16_ReadBuffer(CN_FONT_FLASH_BASE + CN_FONT_BITMAP_SIZE,
                       (uint8_t *)&FirstEntry, sizeof(FirstEntry));
    FirstUnicode = (uint16_t)(FirstEntry >> 16);
    if (FirstUnicode < 0x4E00u || FirstUnicode > 0x9FFFu)
        return;

    bFontPresent = true;
}

bool CN_FONT_IsPresent(void)
{
    return bFontPresent;
}

int16_t CN_FONT_UnicodeToIndex(uint16_t Unicode)
{
    uint16_t Lo = 0;
    uint16_t Hi = CN_FONT_CHAR_COUNT;

    if (!bFontPresent)
        return -1;

    /* The index table is sorted by Unicode, so this is a plain binary search. */
    while (Lo < Hi)
    {
        const uint16_t Mid = (uint16_t)(Lo + ((Hi - Lo) >> 1));
        uint32_t Entry;
        uint16_t StoredUnicode;

        PY25Q16_ReadBuffer(CN_FONT_FLASH_BASE + CN_FONT_BITMAP_SIZE + ((uint32_t)Mid * 4u),
                           (uint8_t *)&Entry, sizeof(Entry));
        StoredUnicode = (uint16_t)(Entry >> 16);

        if (StoredUnicode == Unicode)
            return (int16_t)(Entry & 0xFFFFu);

        if (StoredUnicode < Unicode)
            Lo = (uint16_t)(Mid + 1u);
        else
            Hi = Mid;
    }

    return -1;
}

void CN_FONT_ReadBitmap(uint16_t CharIndex, uint16_t *pBitmap)
{
    PY25Q16_ReadBuffer(CN_FONT_FLASH_BASE + ((uint32_t)CharIndex * CN_FONT_GLYPH_BYTES),
                       (uint8_t *)pBitmap, CN_FONT_GLYPH_BYTES);
}

uint8_t CN_FONT_CharSize(const char *pString)
{
    const uint8_t c = (uint8_t)pString[0];

    /* 0xE4..0xEF covers U+4000..U+FFFF, i.e. every CJK ideograph this font can
     * hold. The two continuation bytes are validated so a stray high byte can
     * never be mistaken for a valid glyph. */
    if (c >= 0xE4u && c <= 0xEFu &&
        ((uint8_t)pString[1] & 0xC0u) == 0x80u &&
        ((uint8_t)pString[2] & 0xC0u) == 0x80u)
        return 3u;

    return 1u;
}

uint16_t CN_FONT_Utf8ToUnicode(const char *pString)
{
    return (uint16_t)((((uint16_t)(uint8_t)pString[0] & 0x0Fu) << 12) |
                      (((uint16_t)(uint8_t)pString[1] & 0x3Fu) << 6) |
                       ((uint16_t)(uint8_t)pString[2] & 0x3Fu));
}

void CN_FONT_UnicodeToUtf8(uint16_t Unicode, char *pOut)
{
    pOut[0] = (char)(0xE0u | (uint8_t)(Unicode >> 12));
    pOut[1] = (char)(0x80u | (uint8_t)((Unicode >> 6) & 0x3Fu));
    pOut[2] = (char)(0x80u | (uint8_t)(Unicode & 0x3Fu));
    pOut[3] = 0;
}

bool CN_FONT_StringHasCjk(const char *pString)
{
    size_t i = 0;

    if (pString == NULL)
        return false;

    while (pString[i] != 0)
    {
        const uint8_t Size = CN_FONT_CharSize(&pString[i]);

        if (Size == 3u)
            return true;

        i += Size;
    }

    return false;
}

size_t CN_FONT_PixelWidth(const char *pString)
{
    size_t Total = 0;
    size_t i = 0;

    if (pString == NULL)
        return 0;

    while (pString[i] != 0)
    {
        if (CN_FONT_CharSize(&pString[i]) == 3u)
        {
            Total += CN_FONT_GLYPH_WIDTH + 1u;
            i += 3u;
        }
        else
        {
            Total += 6u + 1u;
            i++;
        }
    }

    if (Total > 0u)
        Total--;

    return Total;
}
