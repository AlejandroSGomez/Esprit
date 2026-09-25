// Isolated WebKit capability check. No existing window, browser profile or document is accessed.
import AppKit
import WebKit
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
class Probe: NSObject, WKNavigationDelegate {
  let view: WKWebView = {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    return WKWebView(frame: .zero, configuration: configuration)
  }()
  func start() { view.navigationDelegate = self; view.loadHTMLString("<html><body>Synthetic compatibility probe</body></html>", baseURL: nil) }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.evaluateJavaScript("JSON.stringify({readableStream:typeof ReadableStream, reader:typeof ReadableStream.prototype.getReader, asyncIterator:typeof ReadableStream.prototype[Symbol.asyncIterator]})") { result, error in
      print(result ?? error?.localizedDescription ?? "no result")
      CFRunLoopStop(CFRunLoopGetMain())
    }
  }
}
let probe = Probe()
probe.start()
DispatchQueue.main.asyncAfter(deadline: .now()+15) { print("probe timeout"); CFRunLoopStop(CFRunLoopGetMain()) }
CFRunLoopRun()
