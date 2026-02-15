import ARKit
import SceneKit
import UIKit

/// Uses ARKit world tracking to provide **three things** from one session:
///   1. Camera frames (CVPixelBuffer) for streaming to the server
///   2. World position [x, y] in metres from the starting point
///   3. Camera heading (math convention: 0 = East, 90 = North)
///
/// World alignment is `.gravityAndHeading`:
///   x → East,  y → Up,  z → South
/// so floor-plane position = (x, −z).
class ARCameraManager: NSObject, ObservableObject, ARSessionDelegate {

    let session = ARSession()

    /// Called on the ARKit callback queue with each new camera frame
    /// (rate-limited to `targetFPS`).
    var onFrame: ((CVPixelBuffer) -> Void)?

    /// Desired output frame rate.
    var targetFPS: Double = 5

    // MARK: - Published tracking state

    /// Position on the floor plane in metres: [east, north] relative to
    /// the initial offset the user entered.
    @Published var worldPosition: [Double] = [0, 0]

    /// Camera heading in math convention (0° = East, 90° = North).
    @Published var heading: Double = 0

    @Published var isRunning = false
    @Published var permissionDenied = false
    @Published var trackingStatus: String = "Initializing..."

    /// Offset entered by the user (their starting location in the room
    /// relative to center phone).  Set *before* calling `startCapture()`.
    var initialOffset: [Double] = [0, 0]

    // MARK: - Private

    private var lastFrameTime: CFAbsoluteTime = 0

    // MARK: - Public API

    func startCapture() {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            beginSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                if granted { self?.beginSession() }
                else { DispatchQueue.main.async { self?.permissionDenied = true } }
            }
        case .denied, .restricted:
            DispatchQueue.main.async { self.permissionDenied = true }
        @unknown default:
            break
        }
    }

    func stopCapture() {
        session.pause()
        DispatchQueue.main.async {
            self.isRunning = false
            self.trackingStatus = "Stopped"
        }
    }

    // MARK: - Session setup

    private func beginSession() {
        guard ARWorldTrackingConfiguration.isSupported else {
            print("[ARCamera] ARKit world tracking not supported on this device")
            DispatchQueue.main.async { self.trackingStatus = "ARKit not supported" }
            return
        }

        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravityAndHeading   // x=East, y=Up, z=South

        session.delegate = self
        session.run(config, options: [.resetTracking, .removeExistingAnchors])

        DispatchQueue.main.async {
            self.isRunning = true
            self.trackingStatus = "Starting ARKit..."
        }
        print("[ARCamera] ARKit session started with gravityAndHeading alignment")
    }

    // MARK: - ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        // --- Position ---
        let t = frame.camera.transform.columns.3
        let eastDelta  = Double(t.x)      // x = East
        let northDelta = Double(-t.z)      // z = South, so −z = North

        // --- Heading ---
        // Camera looks along −z in local frame.  columns.2 is the z-axis
        // of the camera in world coords, so forward = −columns.2.
        let fwd = -frame.camera.transform.columns.2
        let fwdEast  = Double(fwd.x)
        let fwdNorth = Double(-fwd.z)
        let headingRad = atan2(fwdNorth, fwdEast)          // 0 = East, π/2 = North
        let headingDeg = (headingRad * 180 / .pi + 360)
            .truncatingRemainder(dividingBy: 360)

        DispatchQueue.main.async {
            self.worldPosition = [
                self.initialOffset[0] + eastDelta,
                self.initialOffset[1] + northDelta,
            ]
            self.heading = headingDeg
        }

        // --- Tracking quality ---
        let quality: String
        switch frame.camera.trackingState {
        case .normal:
            quality = "Tracking"
        case .limited(let reason):
            switch reason {
            case .initializing:       quality = "Initializing..."
            case .excessiveMotion:    quality = "Move slower"
            case .insufficientFeatures: quality = "Low features"
            case .relocalizing:       quality = "Relocalizing..."
            @unknown default:         quality = "Limited"
            }
        case .notAvailable:
            quality = "Not available"
        }
        DispatchQueue.main.async { self.trackingStatus = quality }

        // --- Camera frame (rate-limited) ---
        let now = CFAbsoluteTimeGetCurrent()
        if now - lastFrameTime >= 1.0 / targetFPS {
            lastFrameTime = now
            onFrame?(frame.capturedImage)
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        print("[ARCamera] Session error: \(error.localizedDescription)")
        DispatchQueue.main.async { self.trackingStatus = "Error" }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        DispatchQueue.main.async { self.trackingStatus = "Interrupted" }
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        DispatchQueue.main.async { self.trackingStatus = "Resuming..." }
    }
}
