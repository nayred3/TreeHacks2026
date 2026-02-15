import AVFoundation
import UIKit

/// Manages the AVCaptureSession, provides JPEG-ready sample buffers at a
/// configurable frame rate.
class CameraManager: NSObject, ObservableObject {

    let session = AVCaptureSession()

    /// Called on a background queue each time a new frame is available
    /// (rate-limited to `targetFPS`).
    var onFrame: ((CMSampleBuffer) -> Void)?

    /// Desired output frame rate (frames per second).
    var targetFPS: Double = 5

    // MARK: - Private

    private let sessionQueue = DispatchQueue(label: "com.phonecamstream.session")
    private let outputQueue  = DispatchQueue(label: "com.phonecamstream.output")
    private let videoOutput  = AVCaptureVideoDataOutput()
    private var lastFrameTime: CFAbsoluteTime = 0

    // MARK: - Public API

    func startCapture() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.configureSession()
            self.session.startRunning()
        }
    }

    func stopCapture() {
        sessionQueue.async { [weak self] in
            self?.session.stopRunning()
        }
    }

    // MARK: - Session Setup

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
                // Fallback for iOS 16
                if connection.isVideoOrientationSupported {
                    connection.videoOrientation = .portrait
                }
            }
        }
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
