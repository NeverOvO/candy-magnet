import AppKit

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

func makeIcon(pixels: Int) throws -> Data {
    let side = CGFloat(pixels)
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current?.imageInterpolation = .high
    defer { NSGraphicsContext.restoreGraphicsState() }
    let rect = NSRect(x: side * 0.08, y: side * 0.08, width: side * 0.84, height: side * 0.84)
    let silhouette = NSBezierPath(roundedRect: rect, xRadius: side * 0.19, yRadius: side * 0.19)
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(calibratedRed: 0.45, green: 0.28, blue: 0.54, alpha: 0.24)
    shadow.shadowBlurRadius = side * 0.045
    shadow.shadowOffset = NSSize(width: 0, height: -side * 0.018)
    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    NSColor.white.setFill()
    silhouette.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(colors: [
        NSColor(calibratedRed: 0.99, green: 0.80, blue: 0.84, alpha: 1),
        NSColor(calibratedRed: 0.86, green: 0.84, blue: 1, alpha: 1),
        NSColor(calibratedRed: 0.68, green: 0.92, blue: 0.87, alpha: 1)
    ])!.draw(in: silhouette, angle: -35)
    NSColor.white.withAlphaComponent(0.72).setStroke()
    silhouette.lineWidth = max(1, side * 0.008)
    silhouette.stroke()
    let centerRect = NSRect(x: side * 0.24, y: side * 0.24, width: side * 0.52, height: side * 0.52)
    let glass = NSBezierPath(roundedRect: centerRect, xRadius: side * 0.14, yRadius: side * 0.14)
    NSColor.white.withAlphaComponent(0.46).setFill()
    glass.fill()
    NSColor.white.withAlphaComponent(0.86).setStroke()
    glass.lineWidth = max(0.75, side * 0.004)
    glass.stroke()
    if let symbol = NSImage(systemSymbolName: "link", accessibilityDescription: "磁力链接")?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: side * 0.33, weight: .semibold)) {
        symbol.isTemplate = false
        let tinted = NSImage(size: symbol.size)
        tinted.lockFocus()
        NSColor(calibratedRed: 0.39, green: 0.28, blue: 0.58, alpha: 0.95).setFill()
        NSRect(origin: .zero, size: symbol.size).fill()
        symbol.draw(in: NSRect(origin: .zero, size: symbol.size), from: .zero, operation: .destinationIn, fraction: 1)
        tinted.unlockFocus()
        let maxSide = side * 0.39
        let ratio = min(maxSide / tinted.size.width, maxSide / tinted.size.height)
        let size = NSSize(width: tinted.size.width * ratio, height: tinted.size.height * ratio)
        tinted.draw(in: NSRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
    }
    return bitmap.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try makeIcon(pixels: size).write(to: outputDirectory.appendingPathComponent("icon_\(size)x\(size).png"))
    try makeIcon(pixels: size * 2).write(to: outputDirectory.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
