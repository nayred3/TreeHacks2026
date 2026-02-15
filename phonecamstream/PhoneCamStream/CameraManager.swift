import AVFoundation
import UIKit

/// Manages the AVCaptureSession, provides JPEG-ready sample buffers at a
/// configurable frame rate.  Handles camera permission requests.
class CameraManager: NSObject, ObservableObject {

    let session = AVCaptureSession()

    /// Called on a background queue each time a new frame is available
    /// (rate-limited to `targetFPS`).
    var onFrame: ((CMSampleBuffer) -> Void)?

    /// Desired output frame rate (frames per second).
    var targetFPS: Double = 5

    @Published var isRunning = false
    @Published var permissionDenied = false

    // MARK: - Private

    private let sessionQueue = DispatchQueue(label: "com.phonecamstream.session")
    private let outputQueue  = DispatchQueue(label: "com.phonecamstream.output")
    private let videoOutput  = AVCaptureVideoDataOutput()
    private var lastFrameTime: CFAbsoluteTime = 0
    private var isConfigured = false

    // MARK: - Public API

    /// Request camera permission, then start capture if granted.
    func startCapture() {
        let status = AVCaptureDevice.authorizationStatus(for: .video)

        switch status {
        case .authorized:
            beginSession()

        case .notDetermined:
            // First launch — show the system permission dialog
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard let self else { return }
                if granted {
                    self.beginSession()
                } else {
                    DispatchQueue.main.async { self.permissionDenied = true }
                }
            }

        case .denied, .restricted:
            DispatchQueue.main.async { self.permissionDenied = true }
            print("[CameraManager] Camera permission denied")

        @unknown default:
            break
        }
    }

    func stopCapture() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning {
                self.session.stopRunning()
            }
            DispatchQueue.main.async { self.isRunning = false }
        }
    }

    // MARK: - Session Setup

    private func beginSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if !self.isConfigured {
                self.configureSession()
            }
            if !self.session.isRunning {
                self.session.startRunning()
            }
            DispatchQueue.main.async { self.isRunning = true }
        }
    }

    private func configureSession() {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        session.sessionPreset = .medium          // 480×360 – good balance

        // Camera input (back camera)
        guard let camera = AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video, position: .back
        ) else {
            print("[CameraManager] No back camera available")
            return
        }

        do {
            let input = try AVCaptureDeviceInput(device: camera)
            if session.canAddInput(input) {
                session.addInput(input)
            }
        } catch {
            print("[CameraManager] Cannot create camera input: \(error)")
            return
        }

        // Video data output
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String:
                kCVPixelFormatType_32BGRA
        ]
        videoOutput.setSampleBufferDelegate(self, queue: outputQueue)

        if session.canAddOutput(videoOutput) {
            session.addOutput(videoOutput)
        }

        // Lock orientation so the video is consistent
        if let connection = videoOutput.connection(with: .video) {
            if #available(iOS 17.0, *) {
                if connection.isVideoRotationAngleSupported(0) {
                    connection.videoRotationAngle = 0   // landscape
                }
            } else {
                if connection.isVideoOrientationSupported {
                    connection.videoOrientation = .portrait
                }
            }
        }

        isConfigured = true
    }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

extension CameraManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        // Rate-limit to targetFPS
        let now = CFAbsoluteTimeGetCurrent()
        let minInterval = 1.0 / targetFPS
        guard now - lastFrameTime >= minInterval else { return }
        lastFrameTime = now

        onFrame?(sampleBuffer)
    }
}
