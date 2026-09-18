/* Host test for the channel-name cursor-slot helpers: links the real App/cn_font.c
 * against the functions extracted verbatim from App/app/menu.c.
 *
 * Chinese names are authored on the host (tools/webflash/), but they are still
 * edited on the radio afterwards, so the cursor has to move Hanzi at a time and
 * an ASCII write over a Hanzi must not leave stray UTF-8 continuation bytes.
 *
 * Usage: host_editor <cn_font.bin>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

#include "cn_font.h"
#include "driver/keyboard.h"
#include "settings.h"
#include "ui/menu.h"

/* --- globals the extracted code touches ---------------------------------- */

char       edit[17];
int        edit_index;
KEY_Code_t edit_last_key = KEY_INVALID;

#include "extracted_editor.h"

/* --- stubbed external flash ---------------------------------------------- */

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

/* --- harness ------------------------------------------------------------- */

static void check(bool condition, const char *what)
{
    printf("%s %s\n", condition ? "ok  " : "FAIL", what);
    if (!condition)
        gFailures++;
}

int main(int argc, char **argv)
{
    if (argc < 2)
    {
        fprintf(stderr, "usage: %s cn_font.bin\n", argv[0]);
        return 2;
    }

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
    check(CN_FONT_IsPresent(), "font present");

    /* --- cursor slot arithmetic ------------------------------------------ */

    memset(edit, 0, sizeof(edit));
    memcpy(edit, "\xE5\x8C\x97\xE4\xBA\xAC" "A" "\xE4\xB8\xAD" "     ", 15);

    check(MENU_MemNameNextSlotIndex(0) == 3, "next slot skips a whole Hanzi");
    check(MENU_MemNameNextSlotIndex(3) == 6, "next slot skips the second Hanzi");
    check(MENU_MemNameNextSlotIndex(6) == 7, "next slot steps one ASCII byte");
    check(MENU_MemNameNextSlotIndex(7) == 10, "next slot skips the third Hanzi");
    check(MENU_MemNameNextSlotIndex(15) == 15, "next slot clamps at the name end");

    check(MENU_MemNamePrevSlotIndex(10) == 7, "previous slot steps back a Hanzi");
    check(MENU_MemNamePrevSlotIndex(7) == 6, "previous slot steps back one byte");
    check(MENU_MemNamePrevSlotIndex(6) == 3, "previous slot steps back a Hanzi");
    check(MENU_MemNamePrevSlotIndex(0) == 0, "previous slot clamps at 0");

    /* Replacing a Hanzi with an ASCII character must not leave stray UTF-8
     * continuation bytes behind. */
    edit_index = 0;
    MENU_MemNamePutAsciiChar('X');
    check(edit[0] == 'X' && edit[1] == ' ' && edit[2] == ' ',
          "an ASCII write clears the rest of a Hanzi slot");
    MENU_MemNamePutAsciiChar('Y');
    check(edit[0] == 'Y' && edit[1] == ' ' && edit[2] == ' ',
          "a second ASCII write stays clean");

    memset(edit, 0, sizeof(edit));
    strcpy(edit, "AB");
    edit_index = 1;
    MENU_MemNamePutAsciiChar('Z');
    check(strcmp(edit, "AZ") == 0, "an ASCII write over ASCII keeps its neighbours");

    /* The cursor of a name that was written on the host: three Hanzi, six
     * characters, ten big-font columns of ASCII. */
    memset(edit, ' ', sizeof(edit));
    edit[CHANNEL_NAME_MAX_BYTES] = 0;
    {
        char utf8[4];
        int  bi = 0;

        CN_FONT_UnicodeToUtf8(0x4E2D, utf8);
        memcpy(&edit[bi], utf8, 3);
        bi += 3;
        CN_FONT_UnicodeToUtf8(0x5317, utf8);
        memcpy(&edit[bi], utf8, 3);
        bi += 3;

        check(bi == 6, "two Hanzi advance the cursor by six bytes");
        check(CN_FONT_StringHasCjk(edit), "the edited buffer holds Hanzi");
        check(MENU_MemNameNextSlotIndex(0) == 3 && MENU_MemNameNextSlotIndex(3) == 6,
              "the cursor walks a host-written name Hanzi by Hanzi");
        check(MENU_MemNamePrevSlotIndex(6) == 3, "and back again");

        edit[bi] = 0;   /* the save path drops the trailing pads */
        check(CN_FONT_PixelWidth(edit) == 25, "two Hanzi are 25 pixels wide");
    }

    printf("\n%s (%d failure%s)\n", gFailures ? "FAILED" : "all editor checks passed",
           gFailures, gFailures == 1 ? "" : "s");
    free(gFlash);
    return gFailures ? 1 : 0;
}
