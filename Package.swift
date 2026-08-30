// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NotchSPI",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "NotchSPI",
            path: "Sources/NotchSPI"
        ),
        .testTarget(
            name: "NotchSPITests",
            dependencies: ["NotchSPI"],
            path: "Tests",
            sources: ["NotchSPITests"],
            resources: [.copy("Fixtures")]
        )
    ]
)
