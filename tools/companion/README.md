# 副屏 —— UV-K1 / UV-K5 V3 状态显示

一个单文件网页工具（Web Serial），把电台当前的 **A/B 频率、RSSI、电池电压**等
做成一个副屏。不依赖服务器、不加载外部资源、数据全在本机。

## 打开方式

1. 用 **Chrome / Edge / Opera**（需要 Web Serial），或 Firefox 151+。
2. 直接双击 `index.html`（`file://` 可用，脚本不是 module）。
3. 若浏览器拦住，在本目录执行 `python -m http.server 8000`，
   然后访问 <http://localhost:8000/>。

## 用法

1. 点「连接电台」→ 选串口。**USB CDC 选"不设置"波特率**（CDC 无波特率概念）。
2. 连上后会显示固件版本，然后自动开始轮询。
3. 「刷新」下拉框调轮询间隔（默认 250 ms）。

## 数据来源

**本工具不用 K5Viewer 流（0xAA55 那套），全部走命令-应答接口。** 原因是实测固件行为：

| 数据 | 命令 | 需要 | 为什么不用流 |
|---|---|---|---|
| 当前频率 | `0x051B` 读 EEPROM | 总是可用 | 流里的 `frequency` 是**会话开始时的快照**，调谐后不更新 |
| A/B 频道 | `0x051B` 读 EEPROM | 总是可用 | 流的行结构里**没有** A/B 字段 |
| RSSI | `0x0527` | **`ENABLE_EXTRA_UART_CMD=ON`** | 流里的 `meter` 是**会话峰值**，且 TX 时被挪用存功率档 |
| 电池电压 | `0x0529` + 校准 | **`ENABLE_EXTRA_UART_CMD=ON`** | — |

### ⚠️ 关于 `ENABLE_EXTRA_UART_CMD`

`0x0527` 和 `0x0529` 包在 `#ifdef ENABLE_EXTRA_UART_CMD` 里（`App/app/uart.c:907-914`），
而 **`Fusion` / `Labs` 等 preset 都没有打开它**（CMakeCache 里是 `BOOL=FALSE`）。
未编译时固件会走到 `switch` 的 default 分支，**不回任何字节** —— 只能靠超时判定。

要启用 RSSI 和电压显示，重新构建时加上：

```sh
./compile-firmware.sh Labs -DENABLE_EXTRA_UART_CMD=ON
# 或
cmake --preset Labs -DENABLE_EXTRA_UART_CMD=ON && cmake --build --preset Labs
```

工具**会在连接时自动探测**这两条命令（`probeCapabilities`）。不支持的固件上不会
报错卡死，只是把对应字段显示为"不支持"，频率和 A/B 照常工作。日志里会明确写出
是哪个命令缺失、需要哪个编译选项。

### 关键偏移（全部取自固件源码）

| 内容 | 扁平 EEPROM 偏移 | 出处 |
|---|---|---|
| VFO0 频段记录基址 | `0x009000` + band×32 | `settings.c:1227`、`radio.c:385` |
| VFO1 频段记录基址 | `0x009010` + band×32 | 同上 |
| 记忆信道记录 | `channel × 16` | `settings.c:1223` |
| 每个 VFO 当前显示的信道号 | `0x00A010` + 0/6 | `settings.c:213` |
| 主 VFO（TX_VFO） | `0x00A0C3` | `settings.c:296` |
| 电池校准系数 `[3]` | `0x00B140`（+6 处的 u16） | `eeprom_compat.c:75` 映射，`settings.c:540` |

VFO 记录内：`+0x00` u32 接收频率(Hz)、`+0x04` u32 偏频、`+0x0A` 亚音类型、
`+0x0B` 高 4 位调制方式、`+0x0C` 第 2-4 位功率档 / 第 1 位带宽。

## 实测踩过的坑

**1. `0x051B` 有隐藏的认证门槛。** `CMD_051B` 会强制比对时间戳（`uart.c:410-411`）：

```c
if (pCmd->Timestamp != Timestamp)
    return;              // 静默丢弃，没有任何错误回复
```

时间戳只能由 `0x0514` 握手写入（按端口分别存），且 `0x0514`/`0x051B` 都会设
`gSerialConfigCountDown_500ms = 12`（**6 秒有效期**）。所以必须**周期性重新握手**，
本工具每 4 秒做一次。不这么做的话读 EEPROM 会无声失败——这是最难排查的一点。

**2. `0x0529` 返回的不是毫伏，是 ADC 原始 12 位计数。** 见 `board.c:181`：

```c
*pVoltage = LL_ADC_REG_ReadConversionData12(ADC1);
*pCurrent = 0;              // ← 电流恒为 0，固件根本没读
```

换算要套固件的公式（`battery.c:148`）：`(adc × 760) / 校准系数[3]`，结果是 10mV 单位。
校准系数存在扁平地址 `0x00B140`，正常范围 1500–3500，超出时固件自己会回退到 2000
（`settings.c:552-553`）。**电流那一栏固件不支持，本工具显示"不支持"而不是假装有数据。**

**3. RSSI 是原始寄存器值，不是 dBm。** `0x0527` 直读 `BK4819_REG_67` 取低 9 位
（`uart.c:525`），范围 0–511。固件内部转 dBm 用的 `BK9819_GetRSSI_dBm() +
dBmCorrTable[band]` **没有通过命令接口暴露**，所以本工具只显示原始值和相对条。

**4. 读不到"此刻是否在发射"。** 命令接口没有暴露这个瞬时状态。
`TX_VFO` 只表示**用户选中的主 VFO**（0=上/A，1=下/B），不代表正在发射。
`RX_VFO` 更是只在 RAM 里，会被双守候交替、被跨段翻转（`settings.h:184-190`），
EEPROM 里根本没有。所以界面标的是"主 · PTT"而不是"发射中"。

**5. 请求队列必须串行化（已修）。** 早期版本把每个请求无条件压进队列。
在未编译 `ENABLE_EXTRA_UART_CMD` 的固件上，`0x0527` 每次都超时 800 ms，
于是**每条超时都留下一个僵尸条目，新请求继续排在后面**——最终连 `0x0514`
续期握手都永远排不到，而握手一旦过期（`gSerialConfigCountDown_500ms` 只有
6 秒），`0x051B` 也开始静默失败，整个工具表现为"第一次握手成功、之后全哑"。

修复方式：过期的在途事务在新请求进来时被丢弃，握手续期并入 `tick()` 串行执行。
`host_tests/test_protocol.js` 里有针对这个故障的回归测试。

**6. CDC 需要 DTR。** `cdc_acm_data_send_with_dtr` 在 DTR 未置位时**静默丢弃**整帧
（`usbd_cdc_if.c:189`）。若发送超时它还会把 `dtr_enable` 清零（`:196-199`），
之后所有发送都无声失败——症状同样是"电台突然不理人"。重新插拔 USB 可恢复。

## 单位与编号（实测踩过的坑）

| 项 | 说明 |
|---|---|
| 频率 | VFO 记录里的 u32 计数单位是 **10 Hz**（见下方推导），`43950000` = 439.5 MHz |
| 偏频 | `TX_OFFSET_FREQUENCY` 同一单位，方向在 `+0x0B` 低 4 位（0=关 1=加 2=减） |
| 信道号 | 电台屏幕显示的是 `ScreenChannel + 1`（`ui/main.c:1698`），所以内部 0 要显示成"信道 1" |
| 功率 | `OUTPUT_POWER` 索引 `gSubMenu_TXP`，**共 8 项**（`menu.c:207`）：USER / LOW 1-5 / MID / HIGH |
| RSSI | 原始值 0–511，换算见下。省电时会断续，需做保持 |
| 静噪 | `gEeprom.SQUELCH_LEVEL` 在扁平 `0x00A001`，0–9 |
| 亚音 | VFO 里存的是**表索引**，不是频率（`radio.c:287-303`） |

### 频率单位是 10 Hz（最容易搞错的一处）

**权威依据**是电台自己的格式化函数 `App/ui/main.c:304`：

```c
sprintf(pBuffer, "%u.%05u", frequency / 100000u, frequency % 100000u);
```

只有当"1 MHz = 100000 个计数"（即 1 计数 = 10 Hz）时，`f/100000` 才是 MHz
整数部分、`f%100000` 才是 5 位小数部分。若 f 是 Hz 单位，这个公式无意义。

**实测对照**（用户电台屏幕读数为准）：

| EEPROM 原始值 | 电台屏幕 | 用 `/1e6` 的错误结果 |
|---|---|---|
| `43950000` | `439.50000` | `43.95000` ← 小数点左移一位 |
| `43850000` | `438.50000` | `43.85000` |

旁证：固件用 `_1GHz_in_KHz = 100000000`（`frequencies.h:22`）作"1 GHz"判据
（`radio.c:472`），100000000 个计数 = 1e9 Hz，即 1 计数 = 10 Hz。

因此本工具照抄电台的整数/小数拆分（不用浮点除法），避免 `toFixed` 的舍入误差：

```js
var whole = Math.floor(f / 100000);
var frac  = f % 100000;
return whole + "." + String(frac).padStart(5, "0");
```

### RSSI → dBm

固件公式（`bk4819.c:398-402` + `rxtx_log.c:282-284`）：

```c
BK4819_GetRSSI_dBm() = (raw / 2) - 160;          // 整数除法
rssiDbm              = BK4819_GetRSSI_dBm() + dBmCorrTable[band];
```

`dBmCorrTable[7]` 从扁平 `0x00A0B9` 读（每频段一个 int8），默认
`{-15,-16,-10,-4,-7,-6,-1}`（`misc.c:153`）。

**注意固件这里有个越界读**：频段枚举有 8 个值（`frequencies.h:33-43`，含
`BAND7_470MHz = 7`），而 `dBmCorrTable` 只有 7 项。固件写
`dBmCorrTable[gRxVfo->Band]`，电台在 470 MHz 频段时读到的是表外内存。
本工具把索引夹紧到表内，避免主机侧也越界。

**RSSI 为什么会"时有时无"**：空闲时固件会让射频芯片休眠
（`app.c:1476-1481`：`gRxIdleMode = true` + `BK4819_Sleep()`），
此时 `REG_67` 读到 0 或陈旧值。本工具做**读数保持**：读到有效值就刷新并记住，
读到 0 则沿用上次有效值并标注"保持"，超过 `RSSI_HOLD_MS`（4 秒）才清空 ——
既消除闪烁，又不会永远卡在旧读数上。

### 亚音码解码

`CodeType` 在 `+0x0A` 低 4 位（RX）：`0`=关 `1`=CTCSS `2`=DCS正 `3`=DCS反。
显示格式照抄电台（`ui/main.c:2115-2124`）：

- CTCSS → `CTCSS_Options[Code]/10`，如 `CTCSS 100.0Hz`
- DCS → `DCS_Options[Code]` 以**八进制**打印 + `N`/`I` 后缀，如 `DCS 023N`

**索引 0 是合法值**（67.0Hz / 023N），不能用 `!code` 判断"未设置"——
只有 `0xFF` 才是无效哨兵。

## 已知行为

- **本工具会压制 K5Viewer 屏幕流**。固件里**任何**串口命令处理完都会
  `gUART_LockK5Viewer = 20`（`uart.c:1495`），锁流 20 个 tick。这是固件行为，
  不是本工具的 bug。两者不能同时满速跑。
- **频率刷新有延迟**：Eeprom 读取走外部 SPI flash，一轮要读 4~5 次。
  调谐旋钮转得快时频率会有滞后感，静止收听/发射时完全够用。
- 每个 VFO 的功率/带宽/调制显示的是**该 VFO 记录里存的值**，不是实时发射参数。

## 测试

`host_tests/test_protocol.js` 对着固件常量做校验（无需连电台）：

```sh
node tools/companion/host_tests/test_protocol.js
```

覆盖：混淆表与 `uart.c:179-182` 一致、CRC-16 算法、命令帧组包/解包往返、
`ReplyReader` 的任意分片与粘连容错、VFO 地址计算、电压换算。

## 相关文件

- 协议参考实现（刷机工具）：`tools/webflash/js/webflash.js`
- 命令分发表：`App/app/uart.c`
- EEPROM 扁平地址映射：`App/driver/eeprom_compat.c`
