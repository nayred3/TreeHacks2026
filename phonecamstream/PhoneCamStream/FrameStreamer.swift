import AVFoundation
import UIKit
import CoreVideo

/// Converts CVPixelBuffer → JPEG and HTTP-POSTs it to the target host
/// for YOLO person detection.
class FrameStreamer: ObservableObject {

    @Published var isConnected = false

    // MARK: - Private

    private var targetURL: URL?
    private var cameraID: String = ""
    private var jpegQuality: CGFloat = 0.35
    /// Number of HTTP POSTs currently in flight.  Allow a small pipeline
    /// (up to `maxInFlight`) so the camera doesn't stall waiting for the
    /// previous response.  If we're at the limit we drop the frame.
    /// All access to `inFlight` is serialised on `sendQueue`.
    private var inFlight: Int = 0
    private let maxInFlight: Int = 3
    private var sendCount: Int = 0   // debug: total calls to sendFrame
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var urlSession: URLSession?
    private let encodeQueue = DispatchQueue(label: "com.phonecamstream.jpeg", qos: .userInitiated)
    /// Serialises access to `inFlight` (sendFrame is called from ARKit's
    /// background queue while completions arrive on main/network queues).
    private let sendQueue = DispatchQueue(label: "com.phonecamstream.send")

    // MARK: - Public API

    func configure(
        targetHost: String,
        targetPort: UInt16,
        cameraID: String,
        jpegQuality: Double
    ) {
        self.targetURL = URL(string: "http://\(targetHost):\(targetPort)/frame")
        self.cameraID = cameraID
        self.jpegQuality = CGFloat(jpegQuality)

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 2
        cfg.timeoutIntervalForResource = 3
        cfg.httpMaximumConnectionsPerHost = 4
        cfg.httpShouldUsePipelining = true
        self.urlSession = URLSession(configuration: cfg)
        print("[FrameStreamer] configured → \(self.targetURL?.absoluteString ?? "nil") cam=\(cameraID) quality=\(jpegQuality)")
    }

    /// Accept a pixel buffer (from ARKit), encode as JPEG, and POST.
    /// Allows up to `maxInFlight` concurrent uploads so frames keep flowing.
    /// Thread-safe: can be called from any queue (ARKit fires on a background queue).
    func sendFrame(_ pixelBuffer: CVPixelBuffer, completion: @escaping (Bool) -> Void) {
        // Capture the CIImage immediately (pixel buffer may be recycled)
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let ci = ciContext
        let quality = jpegQuality
        let camID = cameraID

        sendCount += 1
        let seq = sendCount  // capture for logging

        // All inFlight bookkeeping goes through sendQueue to avoid data races
        sendQueue.async { [weak self] in
            guard let self else {
                print("[FrameStreamer] [\(seq)] self deallocated — skipping")
                completion(false)
                return
            }
            guard self.inFlight < self.maxInFlight else {
                if seq <= 5 || seq % 50 == 0 {
                    print("[FrameStreamer] [\(seq)] pipeline full (\(self.inFlight)/\(self.maxInFlight)) — dropping")
                }
                completion(false)
                return
            }
            guard let url = self.targetURL else {
                print("[FrameStreamer] [\(seq)] targetURL is nil — was configure() called?")
                completion(false)
                return
            }
            guard let session = self.urlSession else {
                print("[FrameStreamer] [\(seq)] urlSession is nil — was configure() called?")
                completion(false)
                return
            }

            self.inFlight += 1
            if seq <= 3 {
                print("[FrameStreamer] [\(seq)] inFlight=\(self.inFlight), posting to \(url)")
            }

            // Encode JPEG on a separate queue to keep sendQueue free
            self.encodeQueue.async { [weak self] in
                guard let cgImage = ci.createCGImage(ciImage, from: ciImage.extent) else {
                    print("[FrameStreamer] [\(seq)] createCGImage failed")
                    self?.sendQueue.async { self?.inFlight -= 1 }
                    completion(false)
                    return
                }
                let uiImage = UIImage(cgImage: cgImage)
                guard let jpegData = uiImage.jpegData(compressionQuality: quality) else {
                    print("[FrameStreamer] [\(seq)] jpegData encoding failed")
                    self?.sendQueue.async { self?.inFlight -= 1 }
                    completion(false)
                    return
                }

                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
                request.setValue(camID, forHTTPHeaderField: "X-Camera-Id")
                request.setValue(String(Date().timeIntervalSince1970), forHTTPHeaderField: "X-Timestamp")
                request.httpBody = jpegData

                session.dataTask(with: request) { [weak self] _, response, error in
                    let httpOK: Bool
                    if let http = response as? HTTPURLResponse {
                        httpOK = (200...299).contains(http.statusCode)
                    } else {
                        httpOK = false
                    }
                    let success = error == nil && httpOK
                    if !success && (seq <= 5 || seq % 50 == 0) {
                        print("[FrameStreamer] [\(seq)] HTTP failed — error: \(error?.localizedDescription ?? "none"), status: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
                    }
                    self?.sendQueue.async { self?.inFlight -= 1 }
                    DispatchQueue.main.async {
                        self?.isConnected = success
                        completion(success)
                    }
                }.resume()
            }
        }
    }

    func stop() {
        urlSession?.invalidateAndCancel()
        urlSession = nil
        DispatchQueue.main.async { self.isConnected = false }
    }

}
