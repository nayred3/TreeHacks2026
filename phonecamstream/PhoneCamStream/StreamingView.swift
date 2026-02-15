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

    var body: some View {
        ZStack {
            // Full-screen camera preview
            CameraPreviewView(session: cameraManager.session)
                .ignoresSafeArea()

            // Status overlay
            VStack {
                statusOverlay
                    .padding(.horizontal)
                    .padding(.top, 8)

                Spacer()

                // Stop button
                Button(action: stopEverything) {
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
        .onDisappear { stopEverything() }
        .navigationBarBackButtonHidden(true)
        .statusBarHidden()
    }

    // MARK: - Status Overlay

    private var statusOverlay: some View {
        VStack(spacing: 6) {
            // Camera ID + heading
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

            // Position info
            HStack {
                Text("pos (\(config.posX, specifier: "%.1f"), \(config.posY, specifier: "%.1f"))m")
                    .font(.caption2.monospaced())
                Spacer()
                Text("heading \(headingTracker.heading, specifier: "%.1f")°")
                    .font(.caption2.monospaced())
            }

            // Error display
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
        // 1. Start camera capture
        cameraManager.targetFPS = config.streamFPS
        cameraManager.startCapture()

        // 2. Configure frame streamer
        frameStreamer.configure(
            targetHost: config.loganIP,
            targetPort: config.loganPortInt,
            cameraID: config.cameraID,
            jpegQuality: config.jpegQuality
        )

        // 3. Configure position sender
        positionSender.configure(
            targetHost: config.justinIP,
            targetPort: config.justinPortInt,
            cameraID: config.cameraID
        )

        // 4. Start compass
        headingTracker.start()

        // 5. Hook camera frames to streamer
        cameraManager.onFrame = { [weak frameStreamer] sampleBuffer in
            frameStreamer?.sendFrame(sampleBuffer) { success in
                if success {
                    DispatchQueue.main.async { framesSent += 1 }
                } else {
                    DispatchQueue.main.async { lastError = "Frame send failed" }
                }
            }
        }

        // 6. Start position update loop (10 Hz)
        positionTask = Task {
            while !Task.isCancelled {
                let pos = [config.posX, config.posY]
                let hdg = headingTracker.heading

                positionSender.sendPosition(position: pos, heading: hdg) { success in
                    if success {
                        DispatchQueue.main.async { positionsSent += 1 }
                    }
                }

                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
            }
        }
    }

    private func stopEverything() {
        positionTask?.cancel()
        positionTask = nil
        cameraManager.stopCapture()
        frameStreamer.stop()
        positionSender.stop()
        headingTracker.stop()
        onStop()
    }
}
