import AppKit

struct IconGenerationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func makeIcon(from source: NSImage, pixels: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw IconGenerationError(message: "无法创建 \(pixels) 像素图标画布。")
    }

    let side = CGFloat(pixels)
    bitmap.size = NSSize(width: side, height: side)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    defer { NSGraphicsContext.restoreGraphicsState() }
    context.imageInterpolation = .high

    // Resize the supplied artwork only; transparent margins remain transparent.
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: side, height: side).fill(using: .copy)
    let scale = min(side / source.size.width, side / source.size.height)
    let width = source.size.width * scale
    let height = source.size.height * scale
    source.draw(
        in: NSRect(x: (side - width) / 2, y: (side - height) / 2,
                   width: width, height: height),
        from: .zero, operation: .copy, fraction: 1
    )

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw IconGenerationError(message: "无法编码 \(pixels) 像素 PNG 图标。")
    }
    return png
}

do {
    guard CommandLine.arguments.count == 3 else {
        throw IconGenerationError(message: "用法：generate-icon <sourcePNG> <iconsetdir>")
    }
    let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let sourceData = try Data(contentsOf: sourceURL)
    guard let representation = NSBitmapImageRep(data: sourceData),
          let cgImage = representation.cgImage,
          cgImage.width > 0, cgImage.height > 0 else {
        throw IconGenerationError(message: "无法读取图标源文件：\(sourceURL.path)")
    }
    // Use pixel dimensions so embedded DPI metadata cannot distort the artwork.
    let source = NSImage(cgImage: cgImage,
                         size: NSSize(width: CGFloat(cgImage.width), height: CGFloat(cgImage.height)))
    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

    for size in [16, 32, 128, 256, 512] {
        try makeIcon(from: source, pixels: size)
            .write(to: outputDirectory.appendingPathComponent("icon_\(size)x\(size).png"))
        try makeIcon(from: source, pixels: size * 2)
            .write(to: outputDirectory.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
    }
} catch {
    FileHandle.standardError.write(Data("图标生成失败：\(error.localizedDescription)\n".utf8))
    exit(EXIT_FAILURE)
}
