/* Copyright 2023 Dual Tachyon
 * https://github.com/DualTachyon
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 */

#include <string.h>

#ifdef ENABLE_CHINESE
    #include "cn_font.h"
#endif
#include "driver/st7565.h"
#include "external/printf/printf.h"
#include "font.h"
#include "ui/helper.h"
#include "ui/inputbox.h"
#include "misc.h"
#include "settings.h"


void UI_GenerateChannelStringEx(char *pString, const bool bShowPrefix, const uint16_t ChannelNumber)
{
    if (gInputBoxIndex > 0) {
        for (unsigned int i = 0; i < 4; i++) {
            pString[i] = (gInputBox[i] == 10) ? '-' : gInputBox[i] + '0';
        }

        pString[4] = 0;
        return;
    }

    if (bShowPrefix) {
        // BUG here? Prefixed NULLs are allowed
        sprintf(pString, "CH-%04u", ChannelNumber + 1);
    } else if (ChannelNumber == MR_CHANNEL_LAST + 1) {
        strcpy(pString, "None");
    } else if (ChannelNumber == 0xFFFF) {
        strcpy(pString, "NULL");
    } else {
        sprintf(pString, "%04u", ChannelNumber + 1);
    }
}

void UI_PrintStringBuffer(const char *pString, uint8_t * buffer, uint32_t char_width, const uint8_t *font)
{
    const size_t Length = strlen(pString);
    const unsigned int char_spacing = char_width + 1;
    for (size_t i = 0; i < Length; i++) {
        const unsigned int index = pString[i] - ' ' - 1;
        if (pString[i] > ' ' && pString[i] < 127) {
            const uint32_t offset = i * char_spacing + 1;
            memcpy(buffer + offset, font + index * char_width, char_width);
        }
    }
}

void UI_PrintString(const char *pString, uint8_t Start, uint8_t End, uint8_t Line, uint8_t Width)
{
    size_t i;
    size_t Length = strlen(pString);

    if (End > Start)
        Start += (((End - Start) - (Length * Width)) + 1) / 2;

    for (i = 0; i < Length; i++)
    {
        const unsigned int ofs   = (unsigned int)Start + (i * Width);
        if (pString[i] > ' ' && pString[i] < 127)
        {
            const unsigned int index = pString[i] - ' ' - 1;

            /* A glyph is 7 bytes wide: never write past the end of the row. A
             * caller that hands in a long string (a 15-byte channel name, say)
             * used to run off the framebuffer here. */
            if (ofs + 7u > LCD_WIDTH)
                break;

            memcpy(gFrameBuffer[Line + 0] + ofs, &gFontBig[index][0], 7);
            memcpy(gFrameBuffer[Line + 1] + ofs, &gFontBig[index][7], 7);
        }
    }
}

void UI_PrintStringSmall(const char *pString, uint8_t Start, uint8_t End, uint8_t Line, uint8_t char_width, const uint8_t *font)
{
    const size_t Length = strlen(pString);
    const unsigned int char_spacing = char_width + 1;

    if (End > Start) {
        Start += (((End - Start) - Length * char_spacing) + 1) / 2;
    }

    UI_PrintStringBuffer(pString, gFrameBuffer[Line] + Start, char_width, font);
}


void UI_PrintStringSmallNormal(const char *pString, uint8_t Start, uint8_t End, uint8_t Line)
{
    UI_PrintStringSmall(pString, Start, End, Line, ARRAY_SIZE(gFontSmall[0]), (const uint8_t *)gFontSmall);
}

void UI_PrintStringSmallNormalInverse(const char *pString, uint8_t Start, uint8_t End, uint8_t Line)
{
    // First draw the string normally
    UI_PrintStringSmallNormal(pString, Start, End, Line);

    // Now invert the framebuffer bits for the rendered area
    uint8_t len = strlen(pString);
    uint8_t char_width = 7; // small font is typically 6px wide

    uint8_t x_start = Start;
    uint8_t x_end   = Start + (len * char_width) + 1;

    if (End != 0 && x_end > End)
        x_end = End;

    //gFrameBuffer[Line][x_start - 2] ^= 0x3E;
    gFrameBuffer[Line][x_start - 1] ^= 0x7F;
    //gFrameBuffer[Line][x_start - 1] ^= 0xFF;
    for (uint8_t x = x_start; x < x_end; x++)
    {
        gFrameBuffer[Line][x] ^= 0xFF;
        gFrameBuffer[Line - 1][x] ^= 0x80;
    }
    //gFrameBuffer[Line][x_end + 0] ^= 0xFF;
    gFrameBuffer[Line][x_end + 0] ^= 0x7F;
    //gFrameBuffer[Line][x_end + 1] ^= 0x3E;
}


void UI_PrintStringSmallBold(const char *pString, uint8_t Start, uint8_t End, uint8_t Line)
{
#ifdef ENABLE_SMALL_BOLD
    const uint8_t *font = (uint8_t *)gFontSmallBold;
    const uint8_t char_width = ARRAY_SIZE(gFontSmallBold[0]);
#else
    const uint8_t *font = (uint8_t *)gFontSmall;
    const uint8_t char_width = ARRAY_SIZE(gFontSmall[0]);
#endif

    UI_PrintStringSmall(pString, Start, End, Line, char_width, font);
}

void UI_PrintStringSmallBufferNormal(const char *pString, uint8_t * buffer)
{
    UI_PrintStringBuffer(pString, buffer, ARRAY_SIZE(gFontSmall[0]), (uint8_t *)gFontSmall);
}

void UI_PrintStringSmallBufferBold(const char *pString, uint8_t * buffer)
{
#ifdef ENABLE_SMALL_BOLD
    const uint8_t *font = (uint8_t *)gFontSmallBold;
    const uint8_t char_width = ARRAY_SIZE(gFontSmallBold[0]);
#else
    const uint8_t *font = (uint8_t *)gFontSmall;
    const uint8_t char_width = ARRAY_SIZE(gFontSmall[0]);
#endif
    UI_PrintStringBuffer(pString, buffer, char_width, font);
}

void UI_DisplayFrequency(const char *string, uint8_t X, uint8_t Y, bool center)
{
    const unsigned int char_width  = 13;
    uint8_t           *pFb0        = gFrameBuffer[Y] + X;
    uint8_t           *pFb1        = pFb0 + 128;
    bool               bCanDisplay = false;

    uint8_t len = strlen(string);
    for(int i = 0; i < len; i++) {
        char c = string[i];
        if(c=='-') c = '9' + 1;
        if (bCanDisplay || c != ' ')
        {
            bCanDisplay = true;
            if(c>='0' && c<='9' + 1) {
                memcpy(pFb0 + 2, gFontBigDigits[c-'0'],                  char_width - 3);
                memcpy(pFb1 + 2, gFontBigDigits[c-'0'] + char_width - 3, char_width - 3);
            }
            else if(c=='.') {
                *pFb1 = 0x60; pFb0++; pFb1++;
                *pFb1 = 0x60; pFb0++; pFb1++;
                *pFb1 = 0x60; pFb0++; pFb1++;
                continue;
            }

        }
        else if (center) {
            pFb0 -= 6;
            pFb1 -= 6;
        }
        pFb0 += char_width;
        pFb1 += char_width;
    }
}

/*
void UI_DisplayFrequency(const char *string, uint8_t X, uint8_t Y, bool center)
{
    const unsigned int char_width  = 13;
    uint8_t           *pFb0        = gFrameBuffer[Y] + X;
    uint8_t           *pFb1        = pFb0 + 128;
    bool               bCanDisplay = false;

    if (center) {
        uint8_t len = 0;
        for (const char *ptr = string; *ptr; ptr++)
            if (*ptr != ' ') len++; // Ignores spaces for centering

        X -= (len * char_width) / 2; // Centering adjustment
        pFb0 = gFrameBuffer[Y] + X;
        pFb1 = pFb0 + 128;
    }

    for (; *string; string++) {
        char c = *string;
        if (c == '-') c = '9' + 1; // Remap of '-' symbol

        if (bCanDisplay || c != ' ') {
            bCanDisplay = true;
            if (c >= '0' && c <= '9' + 1) {
                memcpy(pFb0 + 2, gFontBigDigits[c - '0'], char_width - 3);
                memcpy(pFb1 + 2, gFontBigDigits[c - '0'] + char_width - 3, char_width - 3);
            } else if (c == '.') {
                memset(pFb1, 0x60, 3); // Replaces the three assignments
                pFb0 += 3;
                pFb1 += 3;
                continue;
            }
        }
        pFb0 += char_width;
        pFb1 += char_width;
    }
}
*/

void UI_DrawPixelBuffer(uint8_t (*buffer)[128], uint8_t x, uint8_t y, bool black)
{
    const uint8_t pattern = 1 << (y % 8);
    if(black)
        buffer[y/8][x] |= pattern;
    else
        buffer[y/8][x] &= ~pattern;
}

static void sort(int16_t *a, int16_t *b)
{
    if(*a > *b) {
        int16_t t = *a;
        *a = *b;
        *b = t;
    }
}

#ifdef ENABLE_FEAT_F4HWN
    /*
    void UI_DrawLineDottedBuffer(uint8_t (*buffer)[128], int16_t x1, int16_t y1, int16_t x2, int16_t y2, bool black)
    {
        if(x2==x1) {
            sort(&y1, &y2);
            for(int16_t i = y1; i <= y2; i+=2) {
                UI_DrawPixelBuffer(buffer, x1, i, black);
            }
        } else {
            const int multipl = 1000;
            int a = (y2-y1)*multipl / (x2-x1);
            int b = y1 - a * x1 / multipl;

            sort(&x1, &x2);
            for(int i = x1; i<= x2; i+=2)
            {
                UI_DrawPixelBuffer(buffer, i, i*a/multipl +b, black);
            }
        }
    }
    */

    void PutPixel(uint8_t x, uint8_t y, bool fill) {
      UI_DrawPixelBuffer(gFrameBuffer, x, y, fill);
    }

    void PutPixelStatus(uint8_t x, uint8_t y, bool fill) {
      UI_DrawPixelBuffer(&gStatusLine, x, y, fill);
    }

    void GUI_DisplaySmallest(const char *pString, uint8_t x, uint8_t y,
                                    bool statusbar, bool fill) {
      uint8_t c;
      uint8_t pixels;
      const uint8_t *p = (const uint8_t *)pString;

      while ((c = *p++) && c != '\0') {
        c -= 0x20;
        for (int i = 0; i < 3; ++i) {
          pixels = gFont3x5[c][i];
          for (int j = 0; j < 6; ++j) {
            if (pixels & 1) {
              if (statusbar)
                PutPixelStatus(x + i, y + j, fill);
              else
                PutPixel(x + i, y + j, fill);
            }
            pixels >>= 1;
          }
        }
        x += 4;
      }
    }

    void GUI_DisplaySmallestInverse(const char *pString, uint8_t x, uint8_t Line,
                                bool statusbar, bool fill, uint8_t end)
    {
        // First draw the string normally
        GUI_DisplaySmallest(pString, x, (Line * 8) + 1, statusbar, fill);

        // Now invert the framebuffer/statusline bits for the rendered area
        uint8_t start = (x - 2);
        uint8_t *buffer = statusbar ? gStatusLine : gFrameBuffer[Line];

        buffer[start] ^= 0x3E;
        for (uint8_t i = start + 1; i < end; i++) {
            buffer[i] ^= 0x7F;
        }
        buffer[end] ^= 0x3E;
    }

    void UI_DisplayUnlockKeyboard(uint8_t shift) {
        if (gEeprom.KEY_LOCK && gKeypadLocked > 0)
        {   // tell user how to unlock the keyboard
            
            //memcpy(gFrameBuffer[shift] + 2, gFontKeyLock, sizeof(gFontKeyLock));
            UI_PrintStringSmallBold("UNLOCK KEYBOARD", 12, 0, shift);
            //memcpy(gFrameBuffer[shift] + 120, gFontKeyLock, sizeof(gFontKeyLock));

            /*
            for (uint8_t i = 12; i < 116; i++)
            {
                gFrameBuffer[shift][i] ^= 0xFF;
            }
            */
        }
    }

    bool IsEmptyName(const char *name, uint8_t len) {
        if (name[0] == '\0' || name[0] == '\xff')
            return true;
        for (uint8_t i = 0; i < len; i++) {
            if (name[i] != ' ' && name[i] != '\xff' && name[i] != '\0')
                return false;
        }
        return true;
    }
#endif
    
void UI_DrawLineBuffer(uint8_t (*buffer)[128], int16_t x1, int16_t y1, int16_t x2, int16_t y2, bool black)
{
    if(x2==x1) {
        sort(&y1, &y2);
        for(int16_t i = y1; i <= y2; i++) {
            UI_DrawPixelBuffer(buffer, x1, i, black);
        }
    } else {
        const int multipl = 1000;
        int a = (y2-y1)*multipl / (x2-x1);
        int b = y1 - a * x1 / multipl;

        sort(&x1, &x2);
        for(int i = x1; i<= x2; i++)
        {
            UI_DrawPixelBuffer(buffer, i, i*a/multipl +b, black);
        }
    }
}

void UI_DrawRectangleBuffer(uint8_t (*buffer)[128], int16_t x1, int16_t y1, int16_t x2, int16_t y2, bool black)
{
    UI_DrawLineBuffer(buffer, x1,y1, x1,y2, black);
    UI_DrawLineBuffer(buffer, x1,y1, x2,y1, black);
    UI_DrawLineBuffer(buffer, x2,y1, x2,y2, black);
    UI_DrawLineBuffer(buffer, x1,y2, x2,y2, black);
}


void UI_DisplayPopup(const char *string)
{
    UI_DisplayClear();

    // for(uint8_t i = 1; i < 5; i++) {
    //  memset(gFrameBuffer[i]+8, 0x00, 111);
    // }

    // for(uint8_t x = 10; x < 118; x++) {
    //  UI_DrawPixelBuffer(x, 10, true);
    //  UI_DrawPixelBuffer(x, 46-9, true);
    // }

    // for(uint8_t y = 11; y < 37; y++) {
    //  UI_DrawPixelBuffer(10, y, true);
    //  UI_DrawPixelBuffer(117, y, true);
    // }
    // DrawRectangle(9,9, 118,38, true);
    UI_PrintString(string, 9, 118, 2, 8);
    UI_PrintStringSmallNormal("Press EXIT", 9, 118, 6);
}

void UI_DisplayClear(void)
{
    memset(gFrameBuffer, 0, sizeof(gFrameBuffer));
}

void UI_StatusClear(void)
{
    memset(gStatusLine, 0, sizeof(gStatusLine));
}

#ifdef ENABLE_CHINESE

/* Write one framebuffer pixel given absolute LCD coordinates. Rows 0..7 are the
 * status line, which these helpers never touch (the caller always works inside
 * the framed area, YStart >= 8). */
static void UI_CjkPixel(uint8_t x, uint8_t y, bool fill)
{
    const uint8_t line = (uint8_t)((y - 8u) >> 3);
    const uint8_t bit  = (uint8_t)(1u << (y & 7u));

    if (x >= LCD_WIDTH || y < 8u || line >= FRAME_LINES)
        return;

    if (fill)
        gFrameBuffer[line][x] |= bit;
    else
        gFrameBuffer[line][x] &= (uint8_t)~bit;
}

/* Blit one 12x12 Hanzi. It is vertically centred inside [YStart, YEnd] so that a
 * name keeps the same optical baseline whether it sits in a 12-pixel band or in
 * a taller one. */
static void UI_DrawCjkGlyph(uint16_t Unicode, uint8_t x, uint8_t YStart, uint8_t YEnd, bool fill)
{
    const int16_t Index = CN_FONT_UnicodeToIndex(Unicode);
    const uint8_t Range = (uint8_t)(YEnd - YStart + 1u);
    uint16_t Bitmap[CN_FONT_GLYPH_ROWS];
    uint8_t y;

    if (Index < 0)
        return;   // not in the font: draw nothing rather than a wrong glyph

    y = YStart;
    if (Range >= CN_FONT_GLYPH_ROWS)
        y = (uint8_t)(YStart + ((Range - CN_FONT_GLYPH_ROWS) / 2u));

    CN_FONT_ReadBitmap((uint16_t)Index, Bitmap);

    for (uint8_t row = 0; row < CN_FONT_GLYPH_ROWS; row++)
    {
        const uint16_t RowData = Bitmap[row];
        const uint8_t  py = (uint8_t)(y + row);

        for (uint8_t col = 0; col < CN_FONT_GLYPH_WIDTH; col++)
        {
            if ((uint8_t)(x + col) >= LCD_WIDTH)
                break;

            if (RowData & (uint16_t)(0x8000u >> col))
                UI_CjkPixel((uint8_t)(x + col), py, fill);
        }
    }
}

static void UI_DrawSmallStringAtPixel(const char *pString, uint8_t Start, uint8_t End,
                                      uint8_t YStart, uint8_t YEnd, uint8_t LatinDownWhenMixed,
                                      bool fill)
{
    const uint8_t  EngWidth  = (uint8_t)ARRAY_SIZE(gFontSmall[0]);   /* 6 */
    const uint8_t  EngHeight = 7u;
    const uint8_t  Range     = (uint8_t)(YEnd - YStart + 1u);
    const bool     bHasCjk   = CN_FONT_StringHasCjk(pString);
    const size_t   Width     = CN_FONT_PixelWidth(pString);
    uint8_t        x         = Start;
    size_t         i         = 0;

    if (End > Start && Width < (size_t)(End - Start))
        x = (uint8_t)(x + ((End - Start - (uint8_t)Width) / 2u));

    while (pString[i] != 0)
    {
        if (CN_FONT_CharSize(&pString[i]) == 3u)
        {
            UI_DrawCjkGlyph(CN_FONT_Utf8ToUnicode(&pString[i]), x, YStart, YEnd, fill);
            x = (uint8_t)(x + CN_FONT_GLYPH_WIDTH + 1u);
            i += 3u;
            continue;
        }

        {
            uint8_t y = YStart;

            if (Range >= EngHeight)
                y = (uint8_t)(YStart + ((Range - EngHeight) / 2u));

            /* Latin sits a couple of pixels high next to Hanzi: nudge it down
             * when the string mixes both scripts. */
            if (bHasCjk && fill)
            {
                const uint8_t Down = (uint8_t)(LatinDownWhenMixed + 1u);

                if (y <= (uint8_t)(255u - Down))
                    y = (uint8_t)(y + Down);
            }

            if (y < 8u)
                y = 8u;

            if (pString[i] > ' ' && pString[i] < 127)
            {
                const unsigned int Index = (unsigned int)(pString[i] - ' ' - 1);

                if (Index < ARRAY_SIZE(gFontSmall))
                {
                    const uint8_t *pGlyph = gFontSmall[Index];
                    const uint8_t  Line   = (uint8_t)((y - 8u) >> 3);
                    const uint8_t  Bit    = (uint8_t)(y & 7u);

                    for (uint8_t col = 0; col < EngWidth; col++)
                    {
                        if ((uint8_t)(x + col) >= LCD_WIDTH)
                            break;

                        const uint8_t Bits = pGlyph[col];
                        uint8_t      *pLow = &gFrameBuffer[Line][x + col];

                        if (fill)
                            *pLow |= (uint8_t)(Bits << Bit);
                        else
                            *pLow &= (uint8_t)~(uint8_t)(Bits << Bit);

                        if ((uint8_t)(Bit + EngHeight) > 8u && (uint8_t)(Line + 1u) < FRAME_LINES)
                        {
                            uint8_t *pHigh = &gFrameBuffer[Line + 1u][x + col];

                            if (fill)
                                *pHigh |= (uint8_t)(Bits >> (8u - Bit));
                            else
                                *pHigh &= (uint8_t)~(uint8_t)(Bits >> (8u - Bit));
                        }
                    }
                }
            }

            x = (uint8_t)(x + EngWidth + 1u);
            i++;
        }
    }
}

void UI_PrintStringSmallAtPixel(const char *pString, uint8_t Start, uint8_t End,
                                uint8_t YStart, uint8_t YEnd, uint8_t LatinDownWhenMixed)
{
    UI_DrawSmallStringAtPixel(pString, Start, End, YStart, YEnd, LatinDownWhenMixed, true);
}

void UI_PrintStringSmallChannelNameBand(const char *pString, uint8_t Start, uint8_t End, uint8_t YTop)
{
    UI_PrintStringSmallAtPixel(pString, Start, End, YTop,
                              (uint8_t)(YTop + (CN_FONT_GLYPH_ROWS - 1u)), 0u);
}

#endif

