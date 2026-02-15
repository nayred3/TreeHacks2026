import SwiftUI
import Combine

struct StreamingView: View {
    @ObservedObject var config: AppConfig
    var onStop: () -> Void

    @StateObject private var cameraManager = CameraManager()
    @StateObject private var frameStreamer = FrameStreamer()
    @StateObject private var positionSender = PositionSender()
    @StateObject private var headingTracker = HeadingTracker()
    @StateObject private var peerClient = MoverPeerClient()

    @State private var framesSent: Int = 0
    @State private var positionsSent: Int = 0
    @State private var positionTask: Task<Void, Never>?
    @State private var hasStopped = false

    /// Current position: UWB-derived if available, else manual fallback.
    private var currentPosition: [Double] {
        peerClient.position ?? [config.posX, config.posY]
    }

    var body: some View {
        ZStack {
            CameraPreviewView(session: cameraManager.session)
                .ignoresSafeArea()

            if cameraManager.permissionDenied {
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
        VStack(spacing: 6) {
            HStack {
                Text(config.cameraID)
                    .font(.headline.monospaced())
                Spacer()
                Image(systemName: "location.north.fill")
                    .rotationEffect(.degrees(-headingTracker.heading))
                Text("\(headingTracker.heading, specifier: "%.0f")°")
                    .font(.caption.monospaced())
            }

            Divider().background(.white.opacity(0.3))

            // UWB peer status
            HStack {
                Circle()
                    .fill(peerClient.isConnectedToAnchor ? .green : .yellow)
                    .frame(width: 8, height: 8)
                Text(peerClient.statusText)
                    .font(.caption2)
                Spacer()
                if let pos = peerClient.position {
                    Text(String(format: "UWB (%.1f, %.1f)", pos[0], pos[1]))
                        .font(.caption2.monospaced())
                        .foregroundColor(.green)
                } else {
                    Text("manual pos")
                        .font(.caption2)
                        .foregroundColor(.yellow)
                }
            }

            // Video stream status
            HStack {
                Circle()
                    .fill(frameStreamer.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text("Video → Logan")
                    .font(.caption2)
                Spacer()
                Text("\(framesSent) frames")
                    .font(.caption2.monospaced())
            }

            // Position stream status
            HStack {
                Circle()
                    .fill(positionSender.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text("Position → Justin")
                    .font(.caption2)
                Spacer()
                Text("\(positionsSent) msgs")
                    .font(.caption2.monospaced())
            }

            // Current position
            HStack {
                Text(String(format: "pos (%.2f, %.2f)m", currentPosition[0], currentPosition[1]))
                    .font(.caption2.monospaced())
                Spacer()
                Text(String(format: "heading %.1f°", headingTracker.heading))
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

        // Camera
        cameraManager.targetFPS = config.streamFPS
        cameraManager.startCapture()

        // Frame streamer
        frameStreamer.configure(
            targetHost: config.loganIP,
            targetPort: config.loganPortInt,
            cameraID: config.cameraID,
            jpegQuality: config.jpegQuality
        )

        // Position sender
        positionSender.configure(
            targetHost: config.justinIP,
            targetPort: config.justinPortInt,
            cameraID: config.cameraID
        )

        // Compass
        headingTracker.start()

        // UWB peer connection to anchor
        peerClient.start(cameraID: config.cameraID)

        // Hook camera frames → streamer
        cameraManager.onFrame = { [weak frameStreamer] sampleBuffer in
            frameStreamer?.sendFrame(sampleBuffer) { success in
                if success {
                    DispatchQueue.main.async { framesSent += 1 }
                }
            }
        }

        // Position update loop (10 Hz) — uses UWB position when available
        positionTask = Task {
            while !Task.isCancelled {
                let pos = currentPosition
                let hdg = headingTracker.heading

                positionSender.sendPosition(position: pos, heading: hdg) { success in
                    if success {
                        DispatchQueue.main.async { positionsSent += 1 }
                    }
                }

                try? await Task.sleep(nanoseconds: 100_000_000)
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
        cameraManager.onFrame = nil
        cameraManager.stopCapture()
        frameStreamer.stop()
        positionSender.stop()
        headingTracker.stop()
        peerClient.stop()
    }
}
