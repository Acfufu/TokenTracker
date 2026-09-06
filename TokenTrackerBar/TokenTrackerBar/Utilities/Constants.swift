import Foundation

enum Constants {
    // Dev variant (Debug config) serves on 7681 so it can coexist with the
    // production app's 7680 server without killing each other (spec §4.1).
    #if DEBUG
    static let serverBaseURL = "http://localhost:7681"
    static let serverPort = 7681
    #else
    static let serverBaseURL = "http://localhost:7680"
    static let serverPort = 7680
    #endif
    static let autoRefreshInterval: TimeInterval = 300
    static let healthCheckInterval: TimeInterval = 30
    static let maxHeatmapWeeks = 52
}
