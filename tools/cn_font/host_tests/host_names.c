/* Host test for the channel-name storage: links the real App/cn_font.c and the
 * name accessors extracted verbatim from App/settings.c against a stubbed
 * external flash, and checks the UTF-8 round trip and truncation rules.
 *
 * Usage: host_names <cn_font.bin>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

#include "cn_font.h"
#include "driver/py25q16.h"
#include "settings.h"

/* --- stubbed name region ------------------------------------------------- */

static uint8_t gNameFlash[0x4000];
static int     gFailures;

void _putchar(char character)
{
    putchar(character);
}

void PY25Q16_ReadBuffer(uint32_t Address, void *pBuffer, uint32_t Size)
{
    const uint32_t offset = Address - 0x004000u;

    if (offset + Size > sizeof(gNameFlash))
    {
        memset(pBuffer, 0, Size);
        return;
    }
    memcpy(pBuffer, gNameFlash + offset, Size);
}

void PY25Q16_WriteBuffer(uint32_t Address, const void *pBuffer, uint32_t Size, bool Append)
{
    const uint32_t offset = Address - 0x004000u;

    (void)Append;
    if (offset + Size > sizeof(gNameFlash))
        return;
    memcpy(gNameFlash + offset, pBuffer, Size);
}

bool RADIO_CheckValidChannel(uint16_t Channel, bool bScanList, uint8_t ScanList)
{
    (void)bScanList;
    (void)ScanList;
    return Channel < 1024u;
}

/* The real accessors, extracted from App/settings.c by the test runner. */
#include "extracted_names.h"

/* --- checks -------------------------------------------------------------- */

static void expect(const char *label, const char *got, const char *want)
{
    if (strcmp(got, want) != 0)
    {
        printf("FAIL %-34s got=\"%s\" want=\"%s\"\n", label, got, want);
        gFailures++;
    }
    else
    {
        printf("ok   %-34s \"%s\"\n", label, got);
    }
}

static void roundtrip(const char *label, const char *name, const char *want)
{
    char out[32];

    SETTINGS_SaveChannelName(7, name);
    memset(out, 0xAA, sizeof(out));
    SETTINGS_FetchChannelName(out, 7);
    expect(label, out, want);
}

int main(int argc, char **argv)
{
    (void)argc;
    (void)argv;

    /* The name region starts out as erased flash. */
    memset(gNameFlash, 0xFF, sizeof(gNameFlash));

    roundtrip("ascii", "CH-01", "CH-01");
    roundtrip("spaces inside kept", "A B C", "A B C");
    roundtrip("trailing spaces trimmed", "ABC   ", "ABC");
    roundtrip("5 hanzi (15 bytes)",
              "\xE5\x8C\x97\xE4\xBA\xAC\xE4\xB8\xAD\xE7\xBB\xA7\xE5\x8F\xB0",
              "\xE5\x8C\x97\xE4\xBA\xAC\xE4\xB8\xAD\xE7\xBB\xA7\xE5\x8F\xB0");
    roundtrip("hanzi + latin", "CH\xE5\x8C\x97\xE4\xBA\xAC", "CH\xE5\x8C\x97\xE4\xBA\xAC");
    roundtrip("empty", "", "");
    roundtrip("15 ascii chars", "ABCDEFGHIJKLMNO", "ABCDEFGHIJKLMNO");

    /* Truncation must never split a UTF-8 sequence: 4 Hanzi + "AB" + a Hanzi is
     * 17 bytes, so the last Hanzi is dropped whole. */
    roundtrip("long mixed truncated",
              "\xE5\x8C\x97\xE4\xBA\xAC\xE4\xB8\xAD\xE7\xBB\xA7" "AB" "\xE5\x8F\xB0",
              "\xE5\x8C\x97\xE4\xBA\xAC\xE4\xB8\xAD\xE7\xBB\xA7" "AB");

    /* A record holding a lone lead byte (a torn write, say) must stop there
     * instead of decoding two unrelated bytes. */
    {
        char out[32];
        const char  *prefix = "\xE5\x8C\x97\xE4\xBA\xAC\xE4\xB8\xAD\xE7\xBB\xA7" "AB";
        const size_t length = 14;
        char          broken[16];

        memset(broken, 0, sizeof(broken));
        memcpy(broken, prefix, length);
        broken[length] = (char)0xE5;
        memcpy(gNameFlash + 11 * CHANNEL_NAME_SLOT_SIZE, broken, sizeof(broken));

        memset(out, 0xAA, sizeof(out));
        SETTINGS_FetchChannelName(out, 11);
        expect("lone lead byte dropped", out, prefix);
    }

    /* Erased and zeroed slots read as empty; a legacy 10-character ASCII record
     * still reads back. */
    {
        char out[32];

        memset(gNameFlash + 13 * CHANNEL_NAME_SLOT_SIZE, 0xFF, 16);
        SETTINGS_FetchChannelName(out, 13);
        expect("erased slot", out, "");

        memset(gNameFlash + 14 * CHANNEL_NAME_SLOT_SIZE, 0, 16);
        SETTINGS_FetchChannelName(out, 14);
        expect("zeroed slot", out, "");

        memset(gNameFlash + 15 * CHANNEL_NAME_SLOT_SIZE, 0, 16);
        memcpy(gNameFlash + 15 * CHANNEL_NAME_SLOT_SIZE, "LEGACY", 6);
        SETTINGS_FetchChannelName(out, 15);
        expect("legacy 10-char record", out, "LEGACY");
    }

    /* A save zero-pads the rest of the slot, so no stale bytes survive. */
    {
        bool clean = true;

        SETTINGS_SaveChannelName(17, "\xE5\x8C\x97");
        for (int i = 3; i < 16; i++)
            if (gNameFlash[17 * CHANNEL_NAME_SLOT_SIZE + i] != 0)
                clean = false;

        if (clean)
            printf("ok   %-34s\n", "slot is zero padded after a save");
        else
        {
            printf("FAIL %-34s\n", "slot is zero padded after a save");
            gFailures++;
        }
    }

    printf("\n%s (%d failure%s)\n", gFailures ? "FAILED" : "all name checks passed",
           gFailures, gFailures == 1 ? "" : "s");
    return gFailures ? 1 : 0;
}
