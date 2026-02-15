import SwiftUI
import Combine

struct StreamingView: View {
    @ObservedObject var config: AppConfig
    var onStop: () -> Void

    @StateObject private var cameraManager = CameraManager()
    @StateObject private var frameStreamer = FrameStreamer()
    @StateObject private var positionSender = PositionSender()
    @StateObject private var headingTracker = HeadingTracker()

    @State private var framesSent: Int = 0
    @State private var positionsSent: Int = 0
    @State private var lastError: String?
    @State private var positionTask: Task<Void, Never>?
    @State private var hasStopped = false          // guard against double-stop

    var body: some View {
        ZStack {
            // Full-screen camera preview (safe even before session is running)
            CameraPreviewView(session: cameraManager.session)
                .ignoresSafeArea()

            // Permission-denied overlay
            if cameraManager.permissionDenied {
                VStack(spacing: 12) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 48))
                    Text("Camera access denied")
                        .font(.headline)
                    Text("Go to Settings → PhoneCamStream → Camera and enable access.")
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                .foregroundColor(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
            }

            // Status overlay + stop button
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
        .onDisappear(perform: cleanUpOnly)      // just release resources, don't navigate
        .navigationBarBackButtonHidden(true)
        .statusBarHidden()
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

            HStack {
                Text("pos (\(config.posX, specifier: "%.1f"), \(config.posY, specifier: "%.1f"))m")
                    .font(.caption2.monospaced())
                Spacer()
                Text("heading \(headingTracker.heading, specifier: "%.1f")°")
                    .font(.caption2.monospaced())
            }

            if let error = lastError {
                Text(error)
                    .font(.caption2)
                    .foregroundColor(.red)
                    .lineLimit(1)
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

        // 1. Camera (requests permission first, then starts capture)
        cameraManager.targetFPS = config.streamFPS
        cameraManager.startCapture()

        // 2. Frame streamer
        frameStreamer.configure(
            targetHost: config.loganIP,
            targetPort: config.loganPortInt,
            cameraID: config.cameraID,
            jpegQuality: config.jpegQuality
        )

        // 3. Position sender
        positionSender.configure(
            targetHost: config.justinIP,
            targetPort: config.justinPortInt,
            cameraID: config.cameraID
        )

        // 4. Compass
        headingTracker.start()

        // 5. Hook camera frames → streamer
        cameraManager.onFrame = { [weak frameStreamer] sampleBuffer in
            frameStreamer?.sendFrame(sampleBuffer) { success in
                DispatchQueue.main.async {
                    if success { framesSent += 1 }
                }
            }
        }

        // 6. Position update loop (10 Hz)
        positionTask = Task {
            while !Task.isCancelled {
                let pos = [config.posX, config.posY]
                let hdg = headingTracker.heading

                positionSender.sendPosition(position: pos, heading: hdg) { success in
                    if success {
                        DispatchQueue.main.async { positionsSent += 1 }
                    }
                }

                try? await Task.sleep(nanoseconds: 100_000_000) // 100 ms
            }
        }
    }

    /// Called when the user explicitly taps Stop → tear down + navigate back.
    private func userTappedStop() {
        guard !hasStopped else { return }
        hasStopped = true
        tearDown()
        onStop()
    }

    /// Called from onDisappear — release resources but do NOT call onStop()
    /// (avoids double-navigation crash).
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
    }
}
