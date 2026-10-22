---
type: scene
density: minimal
style: candy-glass-3d
palette: macaron
image_count: 1
language: none
backend: imagegen
---

# 糖果磁链 App 图标

## 设计用途

macOS Dock、Finder 和项目 README 使用同一图标。图形表达种子转磁力链接的功能，配色延续应用现有的糖果玻璃界面。

## 构图

画布为 1024 × 1024，中央为圆角方形的珍珠白玻璃底板，四周保留透明空间。主体是一枚略微倾斜的粗圆角 U 形磁铁。主体轮廓清楚，开口宽，缩小后仍可辨认。

## 材质与配色

磁铁主体采用淡紫至紫罗兰的半透明糖果玻璃，两端分别使用薄荷绿和蜜桃粉。底板带轻微紫粉反射、柔和倒角和薄高光边缘。阴影紧贴图形，避免大范围光晕。

## 输出约束

- 单个图标，无文字、字母、数字、水印或其他品牌标识。
- 不添加界面截图、浏览器、下载箭头或装饰性小物件。
- 透明背景由 imagegen 直接生成并保留 alpha。
- 图像生成后只进行尺寸与格式转换，不用代码重绘或修补主体。

## 文件

- 完整提示词：`prompts/01-scene-candy-magnet.md`
- 最终图像：`../../macos/Assets/CandyMagnet.png`
- 图标转换程序：`../../macos/GenerateIcon.swift`
- 应用 iconset 与 ICNS 由构建脚本生成。
