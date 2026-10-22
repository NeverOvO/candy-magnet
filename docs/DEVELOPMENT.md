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

脚本根据当前机器的 `uname -m` 选择目标架构，使用 Swift 优化编译生成可执行文件，再生成图标、复制界面资源、执行本地 ad-hoc 签名并打包 ZIP。当前提供的是 arm64 产物，脚本不生成 Universal Binary。

| 路径 | 内容 |
| --- | --- |
| `.build/macos/` | 图标生成器、iconset 等中间文件 |
| `dist/糖果磁链.app` | 可运行的 macOS 应用 |
| `dist/糖果磁链-macOS-arm64.zip` | Apple Silicon 应用压缩包 |

脚本会更新上述生成目录，并将项目许可证、第三方声明和 `licenses/` 中的许可文本复制到 App 的 `Contents/Resources`。它不启动应用、不上传产物，也不执行自动测试。`.build/` 和 `dist/` 不纳入 Git。

## 模块分工

| 文件 | 职责 |
| --- | --- |
| `macos/CandyMagnet.swift` | 应用生命周期、主窗口、历史窗口、菜单、WKWebView 原生接口 |
| `macos/LocalAssetServer.swift` | 通过本机动态端口向 WKWebView 提供白名单内的资源 |
| `macos/HistoryStore.swift` | SQLite 初始化、批量写入、游标分页、七天清理和关闭 |
| `macos/GenerateIcon.swift` | 生成应用图标资源 |
| `macos/Info.plist` | 应用标识、版本、最低系统版本等元数据 |
| `macos/Web/app.js` | 导入队列、去重、转换、结果展示、复制和历史保存重试 |
| `macos/Web/torrent.js` | Bencode 解析、文件指纹与磁力链接生成 |
| `macos/Web/converter-worker.js` | 后台读取与解析文件 |
| `macos/Web/history-store.js` | JavaScript 对原生历史接口的调用封装 |
| `macos/Web/history.js` | 历史记录分组、分页和复制 |
| `macos/Web/index.html`、`styles.css` | 主窗口界面 |
| `macos/Web/history.html`、`history.css` | 历史窗口界面 |

## 内嵌资源

应用启动时创建只监听 `127.0.0.1` 的动态端口，资源根目录是 App 内的 `Contents/Resources/Web`。该服务只读取打包资源，用户选择的种子通过 WebKit File API 处理，不上传给资源服务。

新增界面资源时，同时修改 `scripts/build-macos.sh` 的复制清单和 `LocalAssetServer.swift` 的资源白名单及 MIME 类型。JavaScript 模块使用相对导入，界面资源路径以 App 内部服务根目录为基准。

## 原生接口

界面通过 `window.webkit.messageHandlers.desktop.postMessage(...)` 发起调用，由 `WKScriptMessageHandlerWithReply` 返回 Promise 结果。原生端只接受应用同源主框架的请求。

| action | 请求字段 | 成功结果 |
| --- | --- | --- |
| `copy` | `text` | `{ ok: true }` |
| `history.open` | 无 | `{ ok: true }` |
| `history.append` | `records` 数组 | `{ ok: true }` |
| `history.list` | 可选 `before`、`limit` | `{ ok: true, records, nextCursor }` |

历史记录字段为 `id`、`title`、`magnet`、`convertedAt`。`convertedAt` 使用 Unix 毫秒时间戳，分页游标包含 `convertedAt` 和 `id`。历史页面每次读取 100 条，原生接口每次最多返回 200 条。失败以 Promise 拒绝或 `ok` 状态反馈，界面保留可处理的错误提示。

原生存储发生写入或过期清理时，向历史窗口发送 `history-updated` 事件。

## 转换与性能

导入阶段由单个 Worker 串行读取文件，计算文件指纹并解析元数据，主界面保留转换所需的轻量结果。用户点击“开始转换”后生成磁力链接并保存历史。Worker 不可用时，使用同一解析函数回退处理。

文件队列每页展示 100 项，行节点按状态变化更新；分页不会限制队列总数。单个种子限制为 `500 * 1024` 字节，常量位于 `torrent.js`。

历史写入使用批次，每批最多 50 条或约 256 KiB 字符量；这不限制导入或转换数量。重试沿用记录 UUID，SQLite 以主键处理重复写入。

## 历史数据库

数据表为 `conversion_history`：

```sql
CREATE TABLE conversion_history (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  magnet TEXT NOT NULL,
  converted_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX conversion_history_time
ON conversion_history (converted_at DESC, id DESC);
```

数据库启用 WAL 模式，在后台串行队列中读写。列表使用时间与 ID 组成的游标分页。启动、读写和运行期间每小时的维护会删除超过七天的记录。退出时等待原生队列已经接收的操作完成。

## 版本更新

应用版本在 `macos/Info.plist` 中维护：`CFBundleShortVersionString` 为版本号，`CFBundleVersion` 为构建号。功能变更写入根目录 `CHANGELOG.md`，界面和原生源码通过同一构建脚本打包。

更新时退出运行中的应用，再替换 `.app`。历史目录位于用户的 Application Support 中，独立于应用包；替换应用包不会删除历史记录。

仓库保留源代码、文档与必要的字体资源，不提交构建产物、签名材料、种子或历史数据库。项目未配置自动构建或自动测试工作流。
