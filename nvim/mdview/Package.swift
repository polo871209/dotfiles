// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "mdview",
    // WebPage, WebView and URLSchemeHandler first ship in macOS 26.
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-cmark.git", exact: "0.8.0"),
    ],
    targets: [
        .executableTarget(
            name: "mdview",
            dependencies: [
                .product(name: "cmark-gfm", package: "swift-cmark"),
                .product(name: "cmark-gfm-extensions", package: "swift-cmark"),
            ],
            resources: [.copy("Resources")]
        ),
        .testTarget(name: "mdviewTests", dependencies: ["mdview"]),
    ]
)
