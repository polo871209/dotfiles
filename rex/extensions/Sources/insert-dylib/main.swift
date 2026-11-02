// Ported from rexmod's insertdylib, MIT License, Copyright (c) 2026 Alpcan Aydın:
// https://github.com/alpcanaydin/rexmod/blob/main/cmd/insertdylib/main.go

import Foundation

let magic64: UInt32 = 0xfeed_facf
let segment64: UInt32 = 0x19
let loadDylib: UInt32 = 0xc
let loadWeakDylib: UInt32 = 0x8000_0018
let headerSize = 32
// Zero-fill sections take no file space, so they do not bound the header padding.
let zeroFillSectionTypes: Set<UInt32> = [0x1, 0xc, 0x12]

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("insert-dylib: \(message)\n".utf8))
    exit(code)
}

var arguments = Array(CommandLine.arguments.dropFirst())
let checkOnly = arguments.first == "--check"
if checkOnly { arguments.removeFirst() }
guard arguments.count == 2 else { fail("usage: insert-dylib [--check] BINARY DYLIB_PATH", code: 2) }
let binaryURL = URL(fileURLWithPath: arguments[0])
let dylib = arguments[1]

guard var data = try? Data(contentsOf: binaryURL) else { fail("cannot read \(binaryURL.path)") }

func read32(_ offset: Int) -> UInt32 {
    data.withUnsafeBytes {
        UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
    }
}

func write32(_ value: UInt32, at offset: Int) {
    withUnsafeBytes(of: value.littleEndian) { data.replaceSubrange(offset..<offset + 4, with: $0) }
}

guard data.count >= headerSize, read32(0) == magic64 else {
    fail("\(binaryURL.path) is not a thin 64-bit Mach-O")
}
let commandCount = read32(16)
let commandsSize = Int(read32(20))

var present = false
var firstSection = data.count
var offset = headerSize
for _ in 0..<commandCount {
    let command = read32(offset)
    let size = Int(read32(offset + 4))
    switch command {
    case loadDylib, loadWeakDylib:
        let name = data[(offset + Int(read32(offset + 8)))..<(offset + size)].prefix { $0 != 0 }
        present = present || String(bytes: name, encoding: .utf8) == dylib
    case segment64:
        for section in 0..<Int(read32(offset + 64)) {
            let base = offset + 72 + section * 80
            let fileOffset = Int(read32(base + 48))
            let type = read32(base + 64) & 0xff
            if fileOffset != 0, !zeroFillSectionTypes.contains(type) {
                firstSection = min(firstSection, fileOffset)
            }
        }
    default:
        break
    }
    offset += size
}

if checkOnly {
    print(present ? "present" : "absent")
    exit(present ? 0 : 3)
}
if present {
    print("already present")
    exit(0)
}

let commandSize = (24 + dylib.utf8.count + 1 + 7) & ~7
let start = headerSize + commandsSize
guard start + commandSize <= firstSection else {
    fail("not enough header padding: \(firstSection - start) bytes free, \(commandSize) needed")
}
guard data[start..<start + commandSize].allSatisfy({ $0 == 0 }) else {
    fail("header padding at \(start) is not empty")
}

write32(loadWeakDylib, at: start)
write32(UInt32(commandSize), at: start + 4)
write32(24, at: start + 8)
write32(2, at: start + 12)
write32(0x10000, at: start + 16)
write32(0x10000, at: start + 20)
data.replaceSubrange(start + 24..<start + 24 + dylib.utf8.count, with: Array(dylib.utf8))
write32(commandCount + 1, at: 16)
write32(UInt32(commandsSize + commandSize), at: 20)

do {
    let permissions = try FileManager.default.attributesOfItem(atPath: binaryURL.path)[
        .posixPermissions]
    try data.write(to: binaryURL, options: .atomic)
    try FileManager.default.setAttributes(
        [.posixPermissions: permissions as Any], ofItemAtPath: binaryURL.path)
} catch {
    fail("cannot write \(binaryURL.path): \(error.localizedDescription)")
}
print(
    "added LC_LOAD_WEAK_DYLIB \(dylib), \(firstSection - start - commandSize) bytes of header padding left"
)
