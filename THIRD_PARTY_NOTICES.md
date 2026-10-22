# 系统组件与第三方资源

## macOS 系统组件

应用通过系统 SDK 使用 AppKit、WebKit、Network、UniformTypeIdentifiers 和 SQLite3。构建脚本不下载或复制第三方框架，也不安装 npm 或 Swift 包依赖。

## 图标字体

`macos/Web/assets/zenicon.woff` 是项目内嵌的 ZenIcon 图标字体，由 `styles.css` 中的字体声明和图标码点引用。

ZUI 的[官方图标文档](https://github.com/easysoft/zui/blob/zui1/docs/part/control-icon.md)说明其图标基于 Font Awesome 4.3 定制。Font Awesome 作者为 Dave Gandy；ZUI 项目版权声明为 `Copyright (C) 2014 cnezsoft.com`。本项目没有记录所引入字体的精确上游版本。

字体保留 SIL Open Font License 1.1 授权，不适用本项目代码的 MIT 许可证。上游声明和许可全文随仓库提供：

- [Font Awesome 上游许可声明](licenses/fontawesome-license.md)，来自 [ZUI 字体目录](https://github.com/easysoft/zui/blob/zui1/src/fonts/fontawesome-license.md)。
- [SIL OFL 1.1 全文](licenses/OFL-1.1.txt)，来源为 [SIL 官方文本](https://openfontlicense.org/open-font-license-official-text/)。
- [ZUI MIT 版权与许可声明](licenses/ZUI-MIT.txt)，来自 [ZUI 根目录](https://github.com/easysoft/zui/blob/zui1/LICENSE)。

字体可随应用捆绑分发，分发时保留相应版权声明与 OFL 许可文本。构建脚本将本文件及全部许可文本复制到 App 的 `Contents/Resources` 中。

## 协议参考

磁力链接和种子元数据处理参考以下 BitTorrent 协议文档：

- [BEP 3：The BitTorrent Protocol Specification](https://www.bittorrent.org/beps/bep_0003.html)
- [BEP 9：Extension for Peers to Send Metadata Files](https://www.bittorrent.org/beps/bep_0009.html)
- [BEP 52：The BitTorrent Protocol Specification v2](https://www.bittorrent.org/beps/bep_0052.html)

协议文档作为参考链接提供，其正文没有复制到本仓库。

## 仓库使用范围

项目代码采用 [MIT 许可证](LICENSE)，版权持有人为 NeverOvO。第三方字体与系统组件不属于该许可证的重新授权范围，各自适用其原有许可。
