// Draws the app icon at every size macOS wants, into an .iconset folder:
//   icon <folder>
// The picture is the board's own mark: three columns on a warm tile.
import AppKit

let folder = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

func png(_ pixels: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = context
    let scale = CGFloat(pixels) / 1024
    context.cgContext.scaleBy(x: scale, y: scale)

    // the tile, on the standard macOS icon grid (824pt body in a 1024pt canvas)
    let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 186, yRadius: 186)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(white: 0, alpha: 0.28)
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.shadowBlurRadius = 24
    shadow.set()
    NSColor(srgbRed: 0.80, green: 0.40, blue: 0.26, alpha: 1).setFill()
    tile.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(colors: [
        NSColor(srgbRed: 0.91, green: 0.56, blue: 0.42, alpha: 1),
        NSColor(srgbRed: 0.77, green: 0.36, blue: 0.23, alpha: 1),
    ])!.draw(in: tile, angle: -90)

    // three columns, tallest first, on a 32-unit grid inside the tile
    let unit: CGFloat = 824.0 / 32
    let columns: [(x: CGFloat, height: CGFloat, alpha: CGFloat)] = [(6, 18, 1.0), (13.25, 12, 0.88), (20.5, 8, 0.74)]
    for column in columns {
        let rect = NSRect(x: 100 + column.x * unit, y: 100 + 824 - (7 + column.height) * unit, width: 5.5 * unit, height: column.height * unit)
        NSColor(white: 1, alpha: column.alpha).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 1.5 * unit, yRadius: 1.5 * unit).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
    try png(points * scale).write(to: folder.appendingPathComponent(name))
}
