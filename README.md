# OdyRush

池袋 Grand Cinema Sunshine **IMAX 12 号厅**专用选座脚本。自动选择 1–6 人连座，支持中央区域、全场和高级座位设置。

## 1. 安装 Tampermonkey

1. 用 Chrome 打开 [Tampermonkey 扩展页面](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)，点击 **添加至 Chrome → 添加扩展程序**。
2. 在地址栏输入 `chrome://extensions`，按回车。
3. 找到 **Tampermonkey → 详细信息**，打开 **允许用户脚本**。旧版 Chrome 没有此选项时，按 [官方说明](https://www.tampermonkey.net/faq.php?locale=en&q=Q209)开启开发者模式。
4. 点击 Chrome 右上角的拼图图标，将 Tampermonkey 固定到工具栏。

## 2. 安装脚本

1. 点击 [安装 OdyRush](https://raw.githubusercontent.com/wjin999/OdyRush/main/OdyRush.user.js)。
2. 在弹出的 Tampermonkey 页面点击 **安装**。
3. 打开 Tampermonkey **管理面板**，确认 OdyRush 已启用。

如果安装链接只显示代码：

1. 在代码页面按 `Ctrl + A` 全选，再按 `Ctrl + C` 复制。
2. 点击 Tampermonkey 图标 → **添加新脚本**。
3. 在编辑器里按 `Ctrl + A` 全选默认代码，再按 `Ctrl + V` 替换。
4. 按 `Ctrl + S` 保存，确认脚本已启用。

## 3. 设置选座条件

1. 打开 [池袋影院场次页](https://www.cinemasunshine.co.jp/theater/gdcs/#schedule)，已打开的页面先刷新。
2. 在右上角 **OdyRush** 面板设置人数和选座条件，设置会自动保存。
3. 找到目标电影、日期和 **IMAX 12 号厅**场次，核对时间，并提前完成需要的登录。

| 设置 | 说明 |
| --- | --- |
| 人数 | 1–6 人，选择同排连续座位，不跨过道 |
| 选座区域 | 中央区域只选 G–R 排中央座块；全场也考虑前排和两侧 |
| 高级座位 | 默认关闭；开启后允许需要加价的 Premium／Grand Class |
| 自动选座 | 开启后进入座位页自动执行；关闭后点击“自动分析并选座” |
| 失败标签 | 选择“自动关闭”，可关闭脚本打开的后台明确失败页 |

默认优先选择 **M 排附近的中央连座**，全部空座时双人首选 **M20、M21**。中央区域没有合适连座时会停止，不会自行扩大范围。详细范围和评分见 [选座规则](docs/selection-rules.md)。

## 4. 抢座与付款

1. 确认 **自动选座** 已开启，**失败标签** 设为 **自动关闭**。
2. 开放购票后，**按住 `Ctrl`，用鼠标左键连续点击同一场次的购票链接**，在后台打开多个标签。
3. 保持原场次页在前台，等待后台标签加载。脚本进入选座页后会自动分析并选座；出现明确错误、拥堵或 Cookie 受限的后台失败页会自动关闭。
4. 同场次只有一个标签执行选座，其他标签排队；前一个失败后由后一个接替，成功后不再重复选座。
5. 找到标题带有 **✅ 已进入下一步** 的标签并打开，核对场次、座位和价格，**手动选择票种并付款**。

选座完成后，脚本会自动勾选利用规约并点击“次へ”。正在加载、登录或验证码页面会保留；前台页面和未通过脚本打开的页面也不会自动关闭。
