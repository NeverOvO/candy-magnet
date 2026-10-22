# 开发与构建

糖果磁链使用 Swift 管理 macOS 窗口、文件对话框、剪贴板和历史数据库，通过 WKWebView 展示 App 内嵌界面。界面文件位于 `macos/Web`，随应用打包。

## 构建环境

当前交付目标为 Apple Silicon Mac，最低运行系统为 macOS 12.0。编译使用 Xcode Command Line Tools 提供的 Swift 编译器和 macOS SDK。依赖的 AppKit、WebKit、Network、UniformTypeIdentifiers 与 SQLite3 均来自系统，不使用 npm、Swift Package Manager 或第三方构建工具。

安装编译工具：

```sh
xcode-select --install
```

在仓库根目录执行：

```sh
bash scripts/build-macos.sh
```

脚本根据当前机器的 `uname -m` 选择目标架构，使用 Swift 优化编译生成可执行文件，再转换图标尺寸、复制界面资源和许可文本、执行本地 ad hoc 签名并打包 ZIP。当前提供的是 arm64 产物，脚本不生成 Universal Binary。

| 路径 | 内容 |
| --- | --- |
| `.build/macos/` | 图标生成器、iconset 等中间文件 |
| `dist/糖果磁链.app` | 可运行的 macOS 应用 |
| `dist/CandyMagnet-2.3.0-macOS-arm64.zip` | Apple Silicon 应用压缩包 |

脚本会更新上述生成目录，并将项目许可证、第三方声明和 `licenses/` 中的许可文本复制到 App 的 `Contents/Resources`。它不启动应用、不上传产物，也不执行自动测试。`.build/` 和 `dist/` 不纳入 Git。

## 模块分工

| 文件 | 职责 |
| --- | --- |
| `macos/CandyMagnet.swift` | 应用生命周期、主窗口、历史窗口、菜单、WKWebView 原生接口 |
| `macos/LocalAssetServer.swift` | 通过本机动态端口向 WKWebView 提供白名单内的资源 |
| `macos/HistoryStore.swift` | SQLite 初始化与迁移、批次及操作记录的事务写入、分页、七天清理和关闭 |
| `macos/Assets/CandyMagnet.png` | 应用图标源 PNG |
| `macos/GenerateIcon.swift` | 用 Swift / AppKit 将源 PNG 转换为各尺寸 iconset |
| `design/app-icon/` | 图标方案与完整 imagegen 提示词 |
| `macos/Info.plist` | 应用标识、版本、最低系统版本等元数据 |
| `macos/Web/app.js` | 导入队列、去重、转换批次、结果展示、复制、操作记录和保存重试 |
| `macos/Web/torrent.js` | Bencode 解析、文件指纹与磁力链接生成 |
| `macos/Web/converter-worker.js` | 后台读取与解析文件 |
| `macos/Web/history-store.js` | JavaScript 对原生历史接口的调用封装 |
| `macos/Web/history.js` | 批次与操作记录切换、批次展开、分页、单条复制与日志保存 |
| `macos/Web/index.html`、`styles.css` | 主窗口界面 |
| `macos/Web/history.html`、`history.css` | 历史窗口界面 |

## 图标资源

应用图标是糖果玻璃风格的磁铁，源 PNG 位于 [`macos/Assets/CandyMagnet.png`](../macos/Assets/CandyMagnet.png)。画面使用内置 imagegen 生成，设计过程保存在[图标方案](../design/app-icon/outline.md)与[完整提示词](../design/app-icon/prompts/01-scene-candy-magnet.md)中。

`macos/GenerateIcon.swift` 负责读取源 PNG，通过 AppKit 输出 macOS 所需的各尺寸 iconset；构建脚本随后调用系统 `iconutil` 生成 `CandyMagnet.icns`，写入 App 的 `Contents/Resources`。构建程序只转换尺寸与格式，不绘制图标画面，也不调用 imagegen。替换源 PNG 后，重新运行构建脚本即可更新应用图标。

源 PNG、方案和提示词纳入 Git；iconset、`.icns` 与应用包由构建生成。

## 内嵌资源

应用启动时创建只监听 `127.0.0.1` 的动态端口，资源根目录是 App 内的 `Contents/Resources/Web`。该服务只读取打包资源，用户选择的种子通过 WebKit File API 处理，不上传给资源服务。

新增界面资源时，同时修改 `scripts/build-macos.sh` 的复制清单和 `LocalAssetServer.swift` 的资源白名单及 MIME 类型。JavaScript 模块使用相对导入，界面资源路径以 App 内部服务根目录为基准。

## 原生接口

界面通过 `window.webkit.messageHandlers.desktop.postMessage(...)` 发起调用，由 `WKScriptMessageHandlerWithReply` 返回 Promise 结果。原生端只接受应用同源主框架的请求。

| action | 请求字段 | 成功结果 |
| --- | --- | --- |
| `copy` | `text` | `{ ok: true }` |
| `history.open` | 无 | `{ ok: true }` |
| `history.append` | `records` 数组、`batch` | `{ ok: true }` |
| `history.list` | 可选 `before`、`limit` | 批次列表 `batches` 与 `nextCursor` |
| `history.records` | `batchId`，可选 `offset`、`limit` | 批次内记录 `records` 与 `nextOffset` |
| `history.operations.append` | `operations` 数组 | `{ ok: true }` |
| `history.operations.list` | 可选 `before`、`limit` | 操作列表 `operations` 与 `nextCursor` |

JavaScript 封装位于 `history-store.js`，分别提供 `appendHistory(records, batch)`、`listHistory(...)`、`listBatchRecords(...)`、`appendOperations(...)` 和 `listOperations(...)`。批次列表默认每页 50 批，批次内容默认每页 100 条，操作记录默认每页 100 条。

批次使用开始时间 `startedAt`、完成时间 `completedAt` 和唯一标识，并保存文件数、成功数、失败数及状态。链接记录保留 `id`、`title`、`magnet`、`convertedAt`，通过批次标识和位置保持原顺序。时间使用 Unix 毫秒时间戳；批次和操作列表使用游标分页，批次内容使用偏移分页。失败以 Promise 拒绝或 `ok` 状态反馈，界面显示具体错误和重试入口。

原生存储发生写入或过期清理时，向历史窗口发送 `history-updated` 事件。

## 转换与性能

导入阶段由单个 Worker 串行读取文件，计算文件指纹并解析元数据，主界面保留转换所需的轻量结果。每次点击转换，包括单条重新转换，都创建独立批次，生成磁力链接并保存历史。Worker 不可用时，使用同一解析函数回退处理。

文件队列每页展示 100 项，行节点按状态变化更新；分页不会限制队列总数。单个种子限制为 `500 * 1024` 字节，常量位于 `torrent.js`。

转换批次按用户操作划分，保存重试沿用批次、记录和操作的唯一标识。批次内记录按位置读取，分页不改变链接顺序，也不限制导入或转换数量。

主窗口磁力链接面板和 `textarea` 随可用空间伸展。小窗口保留结果区域的最小高度，通过滚动展示超出的内容。

## 操作记录

转换、奇数行复制、偶数行复制、全部复制、单条复制、导入、清空列表、移除文件及名称和 Tracker 选项变更都会保存操作记录。历史窗口的单条复制使用相同记录流程。操作包含时间、数量、结果和详情，详情可包含文件名与选择的选项，不保存完整文件路径或任意系统剪贴板内容。

只涉及一个已知批次时，操作可保存该批次标识；跨批次结果复制记录涉及的批次数，不关联某一个批次。复制成功与操作记录保存成功分别处理，日志保存失败时保留待保存记录和重试入口，重试不重新写入剪贴板。

## 历史数据库

| 数据表 | 字段与用途 |
| --- | --- |
| `conversion_batches` | `id`、`started_at`、`completed_at`、`total_files`、`success_count`、`failed_count`、`status`，保存一次转换的批次摘要 |
| `batch_records` | `id`、`batch_id`、`position`、`title`、`magnet`、`converted_at`，保存批次中的链接与顺序 |
| `operation_history` | `id`、`action`、`detail`、`item_count`、`created_at`、`success`、`batch_id`，保存操作及可选批次关联 |
| `conversion_history` | 保留旧版逐文件记录的 `id`、`title`、`magnet`、`converted_at` |

应用打开数据库时创建新增表，保留旧表及原始记录。旧版记录通过虚拟集合 `legacy-unbatched-v1` 展示为“旧版记录（批次未知）”，标记 `legacy: true`，不根据时间推断原批次。集合摘要的时间取其中最新记录时间，各条记录仍保留原始转换时间。

数据库启用 WAL 模式，在后台串行队列中使用事务写入。记录标识和 `UNIQUE(batch_id, position)` 约束用于幂等保存，重试不重复插入。`batch_records` 通过外键随批次级联删除。

保留期为滚动的 `7 × 24` 小时。新批次按 `started_at` 整批清理；操作按 `created_at` 清理；旧版记录继续按原始 `converted_at` 逐条清理。启动、读写和运行期间每小时执行过期清理。退出时等待原生队列已经接收的操作完成。

## 版本更新

应用版本在 `macos/Info.plist` 中维护：`CFBundleShortVersionString` 为版本号，`CFBundleVersion` 为构建号。v2.3.0 对应版本号 `2.3.0`、构建号 `8`。变更写入根目录 `CHANGELOG.md`，界面、图标与原生源码通过同一构建脚本打包。

GitHub 发布标签为 `v2.3.0`，发布说明保存在 [`docs/releases/v2.3.0.md`](releases/v2.3.0.md)。Apple Silicon 附件命名为 `CandyMagnet-2.3.0-macOS-arm64.zip`，随 [v2.3.0 Release](https://github.com/NeverOvO/candy-magnet/releases/tag/v2.3.0) 分发；二进制附件不进入源码提交。

构建产物使用 ad hoc 本地签名，没有 Developer ID 签名，也未经过 Apple 公证。发布说明保留该签名状态、arm64 架构和 macOS 12.0 最低系统要求。

更新时退出运行中的应用，再替换 `.app`。历史目录位于用户的 Application Support 中，独立于应用包；替换应用包不会删除历史记录。

仓库保留源代码、文档、图标源 PNG 与必要的字体资源，不提交构建产物、签名材料、种子或历史数据库。项目未配置自动构建或自动测试工作流。
