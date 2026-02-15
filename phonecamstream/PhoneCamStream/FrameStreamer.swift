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
    private var inFlight: Int = 0
    private let maxInFlight: Int = 3
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var urlSession: URLSession?
    private let encodeQueue = DispatchQueue(label: "com.phonecamstream.jpeg", qos: .userInitiated)

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
    }

    /// Accept a pixel buffer (from ARKit), encode as JPEG, and POST.
    /// Allows up to `maxInFlight` concurrent uploads so frames keep flowing.
    func sendFrame(_ pixelBuffer: CVPixelBuffer, completion: @escaping (Bool) -> Void) {
        guard inFlight < maxInFlight,
              let url = targetURL,
              let session = urlSession else {
            completion(false)
            return
        }

        // Encode JPEG off the ARKit callback queue to avoid blocking it
        let ci = ciContext
        let quality = jpegQuality
        let camID = cameraID
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)

        inFlight += 1

        encodeQueue.async { [weak self] in
            guard let cgImage = ci.createCGImage(ciImage, from: ciImage.extent) else {
                DispatchQueue.main.async {
                    self?.inFlight -= 1
                    completion(false)
                }
                return
            }
            let uiImage = UIImage(cgImage: cgImage)
            guard let jpegData = uiImage.jpegData(compressionQuality: quality) else {
                DispatchQueue.main.async {
                    self?.inFlight -= 1
                    completion(false)
                }
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
                DispatchQueue.main.async {
                    self?.inFlight -= 1
                    self?.isConnected = success
                    completion(success)
                }
            }.resume()
        }
    }

    func stop() {
        urlSession?.invalidateAndCancel()
        urlSession = nil
        DispatchQueue.main.async { self.isConnected = false }
    }

}
