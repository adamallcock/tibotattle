import Foundation

struct SemanticOpenTarget {
    let canonicalURL: String
    private let scheme: String
    private let host: String

    init(scheme: String, host: String, canonicalURL: String) {
        self.scheme = scheme
        self.host = host
        self.canonicalURL = canonicalURL
    }

    func accepts(_ url: URL) -> Bool {
        guard let components = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        ) else {
            return false
        }
        return components.scheme?.caseInsensitiveCompare(scheme)
            == .orderedSame
            && components.host?.caseInsensitiveCompare(host) == .orderedSame
            && (components.percentEncodedPath.isEmpty
                || components.percentEncodedPath == "/")
            && components.user == nil
            && components.password == nil
            && components.port == nil
            && components.query == nil
            && components.fragment == nil
    }
}
