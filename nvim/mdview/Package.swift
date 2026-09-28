// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "mdview",
    // WebPage, WebView and URLSchemeHandler first ship in macOS 26.
    platforms: [.macOS(.v26)],
    dependencies: [
        // swift-6.4.0-RELEASE. SwiftPM takes only semver tags, so pin the commit.
        .package(url: "https://github.com/swiftlang/swift-cmark.git", revision: "924936d0427cb25a61169739a7660230bffa6ea6"),
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
