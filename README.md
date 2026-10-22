# 糖果磁链

<img src="macos/Assets/CandyMagnet.png" width="128" alt="糖果磁链：糖果玻璃磁铁应用图标">

项目代码采用 [MIT 许可证](LICENSE)。第三方资源的授权说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

糖果磁链是个人使用的 macOS 种子转磁力链接工具。选择或拖入 `.torrent` 文件，在本机生成磁力链接，并保存最近 7 天的转换历史。

当前版本为 `2.2.1`（构建号 `6`），面向 Apple Silicon Mac，系统要求为 macOS 12.0 及更新版本。应用采用薄荷绿、蜜桃粉与淡紫色玻璃界面，主窗口默认大小为 620 × 740，可调整大小。标题区固定，文件列表与结果区域独立滚动。

## 功能

- 批量选择种子文件，选择或拖入文件夹。
- 导入与转换不设置文件数量上限；单个种子最大为 `500 × 1024` 字节，即 512,000 字节。
- 文件内容去重、逐项转换状态、错误原因、移除与重新转换。
- 支持 BitTorrent v1、v2 及混合格式。
- 默认包含文件名称，默认关闭“保留 Tracker”；两个选项均可手动更改。
- 复制单条链接或复制全部结果，相同内容的结果合并显示。
- 独立的转换历史窗口，按日期与转换时间从新到旧排列，支持分页和单条复制。
- 正常导入、转换完成不显示提示横条；失败或需要处理的信息保留。

种子文件仅在本机处理。转换不连接 Tracker 或 DHT，也不下载种子对应内容。私有种子会提示保留原文件，部分下载器需要原种子中的其他元数据。

## 安装与使用

[下载 v2.2.1 · Apple Silicon](https://github.com/NeverOvO/candy-magnet/releases/download/v2.2.1/CandyMagnet-2.2.1-macOS-arm64.zip)，或打开 [v2.2.1 发布页面](https://github.com/NeverOvO/candy-magnet/releases/tag/v2.2.1)。压缩包适用于 arm64 架构的 Apple Silicon Mac，最低系统为 macOS 12.0。

下载后解压 `CandyMagnet-2.2.1-macOS-arm64.zip`，将“糖果磁链.app”拖入“应用程序”文件夹，再双击打开。源码构建的应用位于 `dist/糖果磁链.app`，安装方式相同。关闭最后一个窗口时，应用退出。

1. 点击“选择文件”或“选择文件夹”，也可把文件或文件夹拖入窗口。
2. 设置是否包含名称、是否保留 Tracker，点击转换按钮。
3. 在文件行中复制单条链接，或复制全部结果。
4. 点击标题区的“历史记录”，打开独立历史窗口。

应用包含 Swift 原生窗口、WebKit 内嵌界面和所需资源。使用应用不需要安装 Node.js，也不需要手动启动服务。应用内部的资源服务仅监听本机回环地址，使用动态端口，并随应用启动和退出。

当前构建使用 ad hoc 本地签名，没有 Developer ID 签名，也未经过 Apple 公证。从其他设备传入的应用可能受到 macOS 的安全检查；源码构建可在当前机器生成应用。

## 从源码构建

构建环境为 Apple Silicon Mac、macOS 12.0 或更新版本，以及 Xcode Command Line Tools。首次配置工具链时执行：

```sh
xcode-select --install
```

克隆公开仓库：

```sh
git clone https://github.com/NeverOvO/candy-magnet.git
cd candy-magnet
```

在项目目录构建：

```sh
bash scripts/build-macos.sh
```

脚本使用系统 Swift 编译器与 AppKit、WebKit、Network、SQLite，将图标源 PNG 转换为 macOS 图标尺寸，复制内嵌界面资源和许可文本，完成本地签名并打包。构建过程不安装第三方依赖。

Apple Silicon 上的产物为：

| 路径 | 内容 |
| --- | --- |
| `dist/糖果磁链.app` | 可直接打开的 macOS 应用 |
| `dist/CandyMagnet-2.2.1-macOS-arm64.zip` | 包含应用的分发压缩包 |
| `.build/macos/` | 构建过程使用的中间文件 |

仓库保存源码、文档与图标源文件，`dist/` 中的应用和压缩包不提交到 Git。带版本号的应用压缩包通过 GitHub Releases 分发。

## 转换历史与数据保留

历史窗口默认大小为 620 × 660，每页显示 100 条记录，按本机日期分组、转换时间倒序排列。每条记录保存名称、磁力链接、转换时间和用于保存重试的唯一标识，不保存原始种子内容或完整文件路径。

历史保留转换时的链接选项。之后更改主窗口的名称或 Tracker 选项，不会改写已有历史。同一转换批次中的重复链接合并；之后再次转换相同内容，会产生新的时间记录。

数据存放在：

```text
~/Library/Application Support/糖果磁链/history.sqlite3
```

SQLite 在后台串行队列中读写，批量写入使用事务。保留期按转换时间计算，为滚动的 `7 × 24` 小时。应用启动、读取、写入时清理过期记录，运行期间还会每小时清理一次。应用关闭期间没有后台清理进程，下次打开时继续清理。

历史写入失败时，当前转换结果仍可复制，主窗口会显示“重试保存历史”。在关闭窗口前点击重试；重试沿用原记录标识，不重复插入已保存的记录。历史读取失败时，历史窗口显示具体原因和重试入口。

清空主窗口中的文件队列不会删除已保存的历史。历史数据库位于应用包之外，替换 `.app` 不会清空尚在保留期内的记录。更多数据处理说明见 [隐私说明](docs/PRIVACY.md)。

## 更新应用

退出糖果磁链，从 [GitHub Releases](https://github.com/NeverOvO/candy-magnet/releases) 下载新版压缩包，解压后用新的“糖果磁链.app”替换“应用程序”文件夹中的旧版本，再次打开。应用没有自动更新机制。

使用源码构建时，在源码目录获取更新并重新构建：

```sh
git pull --ff-only
bash scripts/build-macos.sh
```

使用新生成的 `dist/糖果磁链.app` 替换旧版本。

更新时继续使用原有的 Application Support 数据目录，历史仍按 7 天规则清理。主窗口的文件队列和未保存的转换记录不会跨退出恢复；存在“重试保存历史”提示时，先完成保存再退出。

版本变化见 [更新记录](CHANGELOG.md)。

## 技术结构

| 文件或目录 | 职责 |
| --- | --- |
| `macos/CandyMagnet.swift` | 应用入口、主窗口与历史窗口、菜单、文件对话框、剪贴板及界面消息桥接 |
| `macos/HistoryStore.swift` | SQLite 存储、批量写入、按时间分页与过期清理 |
| `macos/LocalAssetServer.swift` | 供内嵌 WebKit 加载资源的本机服务 |
| `macos/Info.plist` | 应用标识、版本与最低系统要求 |
| `macos/Assets/CandyMagnet.png` | 糖果玻璃磁铁图标的源 PNG |
| `macos/GenerateIcon.swift` | 使用 Swift / AppKit 将源 PNG 转换为各尺寸 iconset |
| `design/app-icon/` | 图标画面方案与完整生成提示词 |
| `macos/Web/index.html`、`styles.css` | 主窗口结构与糖果玻璃样式 |
| `macos/Web/app.js` | 导入队列、目录遍历、分页、转换、复制与历史保存交互 |
| `macos/Web/converter-worker.js` | 后台文件读取、指纹计算和种子解析 |
| `macos/Web/torrent.js` | Bencode 解析、文件指纹与磁力链接生成 |
| `macos/Web/history.html`、`history.css`、`history.js` | 历史窗口界面、分页、刷新与复制 |
| `macos/Web/history-store.js` | 调用原生历史接口 |
| `macos/Web/assets/zenicon.woff` | 本地图标字体 |
| `scripts/build-macos.sh` | 编译、资源打包、本地签名与压缩 |

前端入口由应用加载，修改后的资源通过构建脚本复制进 `.app`。开发模块和构建流程见 [开发说明](docs/DEVELOPMENT.md)，第三方资源信息见 [第三方声明](THIRD_PARTY_NOTICES.md)。

### 应用图标

糖果玻璃磁铁图标由内置 imagegen 生成，源文件保存在 `macos/Assets/CandyMagnet.png`。构建时由 Swift / AppKit 转换尺寸，再通过系统 `iconutil` 生成 `.icns`，同时打包一份 256 像素的内嵌品牌图。主窗口和历史窗口的标题图标与 Dock、Finder 使用同一图标源文件。图标画面不由构建程序绘制。

[图标方案](design/app-icon/outline.md)和[完整提示词](design/app-icon/prompts/01-scene-candy-magnet.md)随源码保存。

### 批量处理

文件读取、内容指纹计算与种子解析优先交给单个受控 Web Worker。入队时缓存生成链接所需的元数据，转换时复用，避免重复读取。Worker 无法启动或异常退出时，使用同一解析模块继续处理。

文件列表每页显示 100 条，缓存可见行并更新变化部分。程序不长期保留每份种子的完整字节副本；历史按游标分页读取，记录行不单独创建玻璃模糊层。分页只控制显示数量，不限制导入和转换总数，实际处理能力取决于本机可用资源。

### 磁力链接生成

解析器直接定位种子文件内 `info` 字段的原始字节范围，不进行解码后重新编码。v1 计算 SHA-1 并生成 `xt=urn:btih:…`；v2 计算 SHA-256 并生成 `xt=urn:btmh:1220…`；混合种子包含两组 `xt` 参数。名称与 Tracker 分别编码为可选的 `dn`、`tr` 参数。

程序检查种子元数据结构，不判断内容是否仍有可用下载节点。v2 分块树的完整性由下载客户端处理。

协议参考：[BEP 3](https://www.bittorrent.org/beps/bep_0003.html)、[BEP 9](https://www.bittorrent.org/beps/bep_0009.html)、[BEP 52](https://www.bittorrent.org/beps/bep_0052.html)。

## 问题排查

| 现象 | 处理方式 |
| --- | --- |
| 构建提示找不到 `xcrun`、Swift 或 SDK | 完成 `xcode-select --install` 安装后，重新执行构建脚本。 |
| 应用无法打开 | 核对系统为 macOS 12.0 或更新版本、设备为 Apple Silicon；当前产物采用 ad hoc 签名，可使用源码在本机重新构建。 |
| 文件没有加入队列 | 查看窗口提示；单文件必须不超过 512,000 字节，完全重复的内容会合并。 |
| 某个文件转换失败 | 查看文件行内的解析错误；重新取得完整种子文件后再次导入，或使用该行的重新转换按钮。 |
| 复制失败 | 查看提示中的具体原因，再次点击复制；原生服务未连接时重新打开应用。 |
| 历史保存失败 | 当前链接仍可复制，关闭窗口前点击“重试保存历史”，并根据错误信息处理磁盘空间或目录写入问题。 |
| 历史读取失败 | 在历史窗口点击重试；失败状态不会显示为空历史。 |
| 找不到早期记录 | 历史只保留最近 7 天，过期记录自动删除；新版本不会补录旧版本未保存的转换。 |
