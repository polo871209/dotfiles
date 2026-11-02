// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "rex-extensions",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "RexExtensions", type: .dynamic, targets: ["Boot", "RexExtensions"]),
        .executable(name: "insert-dylib", targets: ["insert-dylib"]),
    ],
    targets: [
        .target(name: "Boot"),
        .target(name: "RexExtensions", dependencies: ["SessionPicker", "ClaudeUsage"]),
        .target(name: "RexKit"),
        .target(name: "SessionPicker", dependencies: ["RexKit"]),
        .target(name: "ClaudeUsage", dependencies: ["RexKit"]),
        .executableTarget(name: "insert-dylib"),
        .testTarget(name: "SessionPickerTests", dependencies: ["SessionPicker"]),
        .testTarget(name: "ClaudeUsageTests", dependencies: ["ClaudeUsage"]),
    ]
)
