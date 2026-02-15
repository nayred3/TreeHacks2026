import SwiftUI
import Combine

struct StreamingView: View {
    @ObservedObject var config: AppConfig
    var onStop: () -> Void

    @StateObject private var arCamera = ARCameraManager()
    @StateObject private var frameStreamer = FrameStreamer()
    @StateObject private var positionSender = PositionSender()
    @StateObject private var peerClient = MoverPeerClient()

    @State private var framesSent: Int = 0
    @State private var positionsSent: Int = 0
    @State private var positionTask: Task<Void, Never>?
    @State private var hasStopped = false

    /// Best available position: UWB if anchor connected, else ARKit.
    private var currentPosition: [Double] {
        peerClient.position ?? arCamera.worldPosition
    }

    /// Best available heading: ARKit (derived from camera direction).
    private var currentHeading: Double {
        arCamera.heading
    }

    var body: some View {
        ZStack {
            // AR camera preview (full-screen)
            ARCameraPreview(session: arCamera.session)
                .ignoresSafeArea()

            if arCamera.permissionDenied {
                permissionDeniedOverlay
            }

            VStack {
                statusOverlay
                    .padding(.horizontal)
                    .padding(.top, 8)

                Spacer()

                Button(action: userTappedStop) {
                    Label("Stop Streaming", systemImage: "stop.fill")
                        .font(.headline)
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(.red)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                }
                .padding()
            }
        }
        .onAppear(perform: startEverything)
        .onDisappear(perform: cleanUpOnly)
        .navigationBarBackButtonHidden(true)
        .statusBarHidden()
    }

    // MARK: - Permission Denied

    private var permissionDeniedOverlay: some View {
        VStack(spacing: 12) {
            Image(systemName: "camera.fill").font(.system(size: 48))
            Text("Camera access denied")
                .font(.headline)
            Text("Go to Settings → PhoneCamStream → Camera.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .foregroundColor(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }

    // MARK: - Status Overlay

    private var statusOverlay: some View {
        VStack(spacing: 5) {
            // Camera ID + heading
            HStack {
                Text(config.cameraID)
                    .font(.headline.monospaced())
                Spacer()
                Image(systemName: "location.north.fill")
                    .rotationEffect(.degrees(-currentHeading))
                Text(String(format: "%.0f°", currentHeading))
                    .font(.caption.monospaced())
            }

            Divider().background(.white.opacity(0.3))

            // ARKit tracking status
            HStack {
                Circle()
                    .fill(arCamera.trackingStatus == "Tracking" ? .green : .yellow)
                    .frame(width: 8, height: 8)
                Text("ARKit: \(arCamera.trackingStatus)")
                    .font(.caption2)
                Spacer()
                Text(String(format: "pos (%.2f, %.2f)m", currentPosition[0], currentPosition[1]))
                    .font(.caption2.monospaced())
            }

            // UWB anchor status
            HStack {
                Circle()
                    .fill(peerClient.isConnectedToAnchor ? .green :
                          peerClient.statusText.contains("Searching") ? .yellow : .red)
                    .frame(width: 8, height: 8)
                Text(peerClient.isConnectedToAnchor ? "UWB: \(peerClient.statusText)" : "UWB: \(peerClient.statusText)")
                    .font(.caption2)
                Spacer()
                if peerClient.position != nil {
                    Text("UWB pos")
                        .font(.caption2)
                        .foregroundColor(.green)
                }
            }

            // Video stream
            HStack {
                Circle()
                    .fill(frameStreamer.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text("Video stream")
                    .font(.caption2)
                Spacer()
                Text("\(framesSent) frames")
                    .font(.caption2.monospaced())
            }

            // Position stream
            HStack {
                Circle()
                    .fill(positionSender.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text("Position stream")
                    .font(.caption2)
                Spacer()
                Text("\(positionsSent) msgs")
                    .font(.caption2.monospaced())
            }
        }
        .padding(10)
        .background(.ultraThinMaterial)
        .cornerRadius(10)
        .foregroundColor(.primary)
    }

    // MARK: - Lifecycle

    private func startEverything() {
        hasStopped = false

        // 1. ARKit camera + tracking
        arCamera.targetFPS = config.streamFPS
        arCamera.initialOffset = [config.posX, config.posY]
        arCamera.startCapture()

        // 2. Frame streamer → server
        frameStreamer.configure(
            targetHost: config.loganIP,
            targetPort: config.loganPortInt,
            cameraID: config.cameraID,
            jpegQuality: config.jpegQuality
        )

        // 3. Position sender → server
        positionSender.configure(
            targetHost: config.justinIP,
            targetPort: config.justinPortInt,
            cameraID: config.cameraID
        )

        // 4. UWB peer connection (optional — uses UWB position if anchor available)
        peerClient.start(cameraID: config.cameraID)

        // 5. Hook ARKit frames → streamer
        arCamera.onFrame = { [weak frameStreamer] pixelBuffer in
            frameStreamer?.sendFrame(pixelBuffer) { success in
                if success {
                    DispatchQueue.main.async { framesSent += 1 }
                }
            }
        }

        // 6. Position update loop (20 Hz for smoother heading)
        positionTask = Task {
            while !Task.isCancelled {
                // Read latest values from published properties
                let pos = await MainActor.run { currentPosition }
                let hdg = await MainActor.run { currentHeading }

                positionSender.sendPosition(position: pos, heading: hdg) { success in
                    if success {
                        DispatchQueue.main.async { positionsSent += 1 }
                    }
                }

                try? await Task.sleep(nanoseconds: 50_000_000)  // 50ms = 20 Hz
            }
        }
    }

    private func userTappedStop() {
        guard !hasStopped else { return }
        hasStopped = true
        tearDown()
        onStop()
    }

    private func cleanUpOnly() {
        tearDown()
    }

    private func tearDown() {
        positionTask?.cancel()
        positionTask = nil
        arCamera.onFrame = nil
        arCamera.stopCapture()
        frameStreamer.stop()
        positionSender.stop()
        peerClient.stop()
    }
}
