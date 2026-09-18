/* Host test for the Chinese font layer and the mixed CJK/Latin drawing helpers:
 * links the real App/cn_font.c, App/ui/helper.c and App/font.c against a stubbed
 * external flash that serves the font blob.
 *
 * Usage: host_font <cn_font.bin> [--art]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

#include "cn_font.h"
#include "driver/st7565.h"
#include "misc.h"
#include "ui/helper.h"

uint8_t  gStatusLine[LCD_WIDTH];
uint8_t  gFrameBuffer[FRAME_LINES][LCD_WIDTH];
char     gInputBox[8];
uint8_t  gInputBoxIndex;

static uint8_t *gFlash;
static uint32_t gFlashSize;
static int      gFailures;

void _putchar(char character)
{
    putchar(character);
}

void PY25Q16_ReadBuffer(uint32_t Address, void *pBuffer, uint32_t Size)
{
    const uint32_t offset = Address - CN_FONT_FLASH_BASE;

    if (offset >= gFlashSize)
    {
        memset(pBuffer, 0xFF, Size);
        return;
    }
    if (offset + Size > gFlashSize)
        Size = gFlashSize - offset;

    memcpy(pBuffer, gFlash + offset, Size);
}

void PY25Q16_ReadBufferSafe(uint32_t Address, void *pBuffer, uint32_t Size)
{
    PY25Q16_ReadBuffer(Address, pBuffer, Size);
}

static void check(bool condition, const char *what)
{
    printf("%s %s\n", condition ? "ok  " : "FAIL", what);
    if (!condition)
        gFailures++;
}

static bool pixel_at(int x, int y)
{
    const int line = (y - 8) / 8;

    if (x < 0 || x >= LCD_WIDTH || line < 0 || line >= FRAME_LINES)
        return false;

    return (gFrameBuffer[line][x] & (1u << (y & 7))) != 0;
}

static void dump(void)
{
    for (int line = 0; line < FRAME_LINES; line++)
    {
        for (int y = 0; y < 8; y++)
        {
            for (int x = 0; x < LCD_WIDTH; x++)
                putchar((gFrameBuffer[line][x] & (1u << y)) ? '#' : '.');

            putchar('\n');
        }
    }
}

/* Every pixel of a Hanzi drawn in [y_start, y_end] must match the bitmap read
 * straight from the blob, page crossing included. */
static void check_glyph_pixels(uint16_t unicode, int sx, int y_start, int y_end, const char *label)
{
    uint16_t bitmap[CN_FONT_GLYPH_ROWS];
    const int16_t index = CN_FONT_UnicodeToIndex(unicode);
    char utf8[4];
    int errors = 0;
    int expected_top;

    if (index < 0)
    {
        check(false, label);
        return;
    }

    CN_FONT_ReadBitmap((uint16_t)index, bitmap);
    CN_FONT_UnicodeToUtf8(unicode, utf8);

    memset(gFrameBuffer, 0, sizeof(gFrameBuffer));
    UI_PrintStringSmallAtPixel(utf8, (uint8_t)sx, (uint8_t)sx, (uint8_t)y_start, (uint8_t)y_end, 0u);

    expected_top = y_start;
    if (y_end - y_start + 1 >= (int)CN_FONT_GLYPH_ROWS)
        expected_top = y_start + ((y_end - y_start + 1 - (int)CN_FONT_GLYPH_ROWS) / 2);

    for (int row = 0; row < (int)CN_FONT_GLYPH_ROWS; row++)
    {
        for (int col = 0; col < (int)CN_FONT_GLYPH_WIDTH; col++)
        {
            const bool want = (bitmap[row] & (0x8000u >> col)) != 0;
            const bool got = pixel_at(sx + col, expected_top + row);

            if (want != got)
                errors++;
        }
    }

    check(errors == 0, label);
}

int main(int argc, char **argv)
{
    bool art = false;

    if (argc < 2)
    {
        fprintf(stderr, "usage: %s cn_font.bin [--art]\n", argv[0]);
        return 2;
    }

    art = (argc > 2 && strcmp(argv[2], "--art") == 0);

    {
        FILE *fp = fopen(argv[1], "rb");

        if (fp == NULL)
        {
            perror(argv[1]);
            return 2;
        }
        fseek(fp, 0, SEEK_END);
        gFlashSize = (uint32_t)ftell(fp);
        fseek(fp, 0, SEEK_SET);
        gFlash = malloc(gFlashSize);
        if (fread(gFlash, 1, gFlashSize, fp) != gFlashSize)
            return 2;
        fclose(fp);
    }

    CN_FONT_Init();
    check(CN_FONT_IsPresent(), "font blob accepted at boot");
    check(CN_FONT_UnicodeToIndex(0x7684) == 0, "first glyph of the blob is U+7684");
    check(CN_FONT_UnicodeToIndex(0x0041) < 0, "a Latin codepoint is not in the font");

    /* UTF-8 helpers. */
    {
        const char *beijing = "\xE5\x8C\x97\xE4\xBA\xAC";       /* 北京 */
        const char *mixed   = "CH\xE5\x8C\x97\xE4\xBA\xAC" " 1";
        char        roundtrip[4];

        check(CN_FONT_CharSize(beijing) == 3 && CN_FONT_CharSize("a") == 1,
              "a Hanzi is three bytes, Latin one");
        check(CN_FONT_StringHasCjk(beijing) && !CN_FONT_StringHasCjk("CH-01"),
              "CJK detection");
        check(CN_FONT_Utf8ToUnicode(beijing) == 0x5317, "UTF-8 decodes to U+5317");
        CN_FONT_UnicodeToUtf8(0x5317, roundtrip);
        check(memcmp(roundtrip, beijing, 3) == 0, "UTF-8 round trip");
        check(CN_FONT_PixelWidth(beijing) == 25 && CN_FONT_PixelWidth(mixed) == 53,
              "mixed width accounting (13 px per Hanzi, 7 px per Latin)");
        check(CN_FONT_PixelWidth("") == 0, "empty string has no width");
    }

    /* Bitmap rendering, including the page crossing at LCD row 16. */
    check_glyph_pixels(0x5317, 5, 8, 23, "Hanzi blit matches the blob (16-row band)");
    check_glyph_pixels(0x4E2D, 40, 24, 39, "Hanzi blit matches the blob (page-aligned band)");
    check_glyph_pixels(0x5317, 5, 8, 19, "Hanzi blit matches the blob (12-row band)");

    /* Centring inside an x window, and no centring when End == Start. */
    {
        int leftmost = -1;

        memset(gFrameBuffer, 0, sizeof(gFrameBuffer));
        UI_PrintStringSmallAtPixel("\xE5\x8C\x97\xE4\xBA\xAC", 0, 127, 8, 23, 0u);

        for (int x = 0; x < LCD_WIDTH && leftmost < 0; x++)
            for (int y = 8; y <= 23; y++)
                if (pixel_at(x, y))
                {
                    leftmost = x;
                    break;
                }

        check(leftmost == (127 - 25) / 2 + 1 || leftmost == (127 - 25) / 2,
              "text is centred in the x window");

        memset(gFrameBuffer, 0, sizeof(gFrameBuffer));
        UI_PrintStringSmallAtPixel("A", 20, 20, 8, 15, 0u);
        check(!pixel_at(19, 8) && (pixel_at(20, 9) || pixel_at(21, 9)),
              "End == Start draws at Start without centring");
    }

    /* Latin is nudged down next to Hanzi, and left alone in pure ASCII. */
    {
        int ascii_top = -1;
        int mixed_top = -1;

        memset(gFrameBuffer, 0, sizeof(gFrameBuffer));
        UI_PrintStringSmallAtPixel("A", 0, 0, 8, 23, 0u);
        for (int y = 8; y <= 23 && ascii_top < 0; y++)
            for (int x = 0; x < 8; x++)
                if (pixel_at(x, y))
                {
                    ascii_top = y;
                    break;
                }

        memset(gFrameBuffer, 0, sizeof(gFrameBuffer));
        UI_PrintStringSmallAtPixel("A\xE5\x8C\x97", 0, 0, 8, 23, 0u);
        for (int y = 8; y <= 23 && mixed_top < 0; y++)
            for (int x = 0; x < 8; x++)
                if (pixel_at(x, y))
                {
                    mixed_top = y;
                    break;
                }

        check(ascii_top > 0 && mixed_top == ascii_top + 1,
              "Latin drops one pixel when mixed with Hanzi");
    }

    if (art)
    {
        printf("\n--- \"CH\xE5\x8C\x97\xE4\xBA\xAC 1\" in rows 8..23 at x=33\n");
        memset(gFrameBuffer, 0, sizeof(gFrameBuffer));
        UI_PrintStringSmallAtPixel("CH\xE5\x8C\x97\xE4\xBA\xAC" " 1", 33, 0, 8, 23, 0u);
        dump();
    }

    printf("\n%s (%d failure%s)\n", gFailures ? "FAILED" : "all font checks passed",
           gFailures, gFailures == 1 ? "" : "s");
    free(gFlash);
    return gFailures ? 1 : 0;
}
