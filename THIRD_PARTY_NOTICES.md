# 系统组件与第三方资源

## macOS 系统组件

应用通过系统 SDK 使用 AppKit、WebKit、Network、UniformTypeIdentifiers 和 SQLite3。构建脚本不下载或复制第三方框架，也不安装 npm 或 Swift 包依赖。

## 图标字体

`macos/Web/assets/zenicon.woff` 是项目内嵌的图标字体，由 `styles.css` 中的 `ZenIcon` 字体和图标码点引用。仓库当前没有附带该字体的独立许可文本，此文件不为该字体授予额外的使用或分发许可。

## 协议参考

磁力链接和种子元数据处理参考以下 BitTorrent 协议文档：

- [BEP 3：The BitTorrent Protocol Specification](https://www.bittorrent.org/beps/bep_0003.html)
- [BEP 9：Extension for Peers to Send Metadata Files](https://www.bittorrent.org/beps/bep_0009.html)
- [BEP 52：The BitTorrent Protocol Specification v2](https://www.bittorrent.org/beps/bep_0052.html)

协议文档作为参考链接提供，其正文没有复制到本仓库。

## 仓库使用范围

此仓库用于个人项目的私有保存与维护，未添加开源许可证。
