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
    private var jpegQuality: CGFloat = 0.5
    private var isSending = false
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var urlSession: URLSession?

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
        cfg.timeoutIntervalForRequest = 3
        cfg.timeoutIntervalForResource = 5
        cfg.httpMaximumConnectionsPerHost = 2
        self.urlSession = URLSession(configuration: cfg)
    }

    /// Accept a pixel buffer (from ARKit), encode as JPEG, and POST.
    /// Skips if a previous send is still in flight.
    func sendFrame(_ pixelBuffer: CVPixelBuffer, completion: @escaping (Bool) -> Void) {
        guard !isSending,
              let url = targetURL,
              let session = urlSession else {
            completion(false)
            return
        }

        guard let jpegData = encodeJPEG(pixelBuffer) else {
            completion(false)
            return
        }

        isSending = true

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue(cameraID, forHTTPHeaderField: "X-Camera-Id")
        request.setValue(String(Date().timeIntervalSince1970), forHTTPHeaderField: "X-Timestamp")
        request.httpBody = jpegData

        session.dataTask(with: request) { [weak self] _, response, error in
            self?.isSending = false
            let httpOK: Bool
            if let http = response as? HTTPURLResponse {
                httpOK = (200...299).contains(http.statusCode)
            } else {
                httpOK = false
            }
            let success = error == nil && httpOK
            DispatchQueue.main.async {
                self?.isConnected = success
                completion(success)
            }
        }.resume()
    }

    func stop() {
        urlSession?.invalidateAndCancel()
        urlSession = nil
        DispatchQueue.main.async { self.isConnected = false }
    }

    // MARK: - JPEG Encoding

    private func encodeJPEG(_ pixelBuffer: CVPixelBuffer) -> Data? {
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return nil }
        let uiImage = UIImage(cgImage: cgImage)
        return uiImage.jpegData(compressionQuality: jpegQuality)
    }
}
