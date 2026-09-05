import AppKit
import UniformTypeIdentifiers

let appURL = URL(fileURLWithPath: "/Applications/MashDavood.app")
var types: [UTType] = []
for ext in ["md", "markdown", "mdown", "mkd"] {
    if let t = UTType(filenameExtension: ext) { types.append(t) }
}
if let t = UTType("net.daringfireball.markdown") { types.append(t) }

let group = DispatchGroup()
for t in types {
    group.enter()
    NSWorkspace.shared.setDefaultApplication(at: appURL, toOpen: t) { err in
        if let err = err { print("FAIL \(t.identifier): \(err.localizedDescription)") }
        else { print("OK   \(t.identifier)") }
        group.leave()
    }
}
_ = group.wait(timeout: .now() + 20)
